import {
  StringEnum,
  associateExtensionConfig,
  configField,
  createRuntimeCodingTools,
  defineExtensionConfig,
  type ExtensionContext,
  type FelanExtension,
} from '@felan-ai/agent-core';
import { Key, Text } from '@earendil-works/pi-tui';
import { Type, type Static } from 'typebox';
import { normalizeBackgroundCommand } from './command-normalizer.js';
import {
  isTerminalStatus,
  type BackgroundBashJob,
  type BackgroundBashStatusFilter,
} from './job-store.js';
import { BackgroundBashManager } from './process-manager.js';
import { BackgroundBashCoordinator } from './coordinator.js';
import { inspectBackgroundBashRuntime } from './runtime-support.js';
import { BackgroundBashView } from './ui/background-bash-view.js';
import {
  BACKGROUND_BASH_COMPLETION_MESSAGE_TYPE,
  registerBackgroundBashCompletionRenderer,
} from './ui/completion-message.js';

const STATUS_VALUES = ['running', 'completed', 'failed', 'killed', 'unknown', 'all'] as const;
const SIGNAL_VALUES = ['SIGTERM', 'SIGKILL'] as const;
const COMPLETION_POLL_MS = 500;
const BACKGROUND_TOOL_NAMES = [
  'list_background_bash',
  'read_background_bash',
  'wait_background_bash',
  'stop_background_bash',
  'write_background_bash',
] as const;

export function supportsBackgroundBashModel(model: unknown): boolean {
  return model !== undefined;
}

const BashParams = Type.Object({
  command: Type.String({ description: 'Bash command to execute' }),
  timeout: Type.Optional(Type.Number({ minimum: 0, description: 'Seconds to wait before promoting the same process to the background. Defaults to 120; 0 backgrounds immediately.' })),
  background: Type.Optional(Type.Boolean({
    description: 'Start a background process and return immediately',
  })),
  tty: Type.Optional(Type.Boolean({ description: 'Start with a PTY so write_background_bash can send stdin and control bytes' })),
}, { additionalProperties: false });

const ListBackgroundBashParams = Type.Object({
  status: Type.Optional(StringEnum(STATUS_VALUES, { description: 'Filter processes by status' })),
}, { additionalProperties: false });

const ReadBackgroundBashParams = Type.Object({
  id: Type.String({ description: 'Background process id returned by bash' }),
  lines: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 1_000,
    description: 'Number of trailing log lines to return. Default: 80.',
  })),
}, { additionalProperties: false });

const WaitBackgroundBashParams = Type.Object({
  id: Type.String({ description: 'Background process id returned by bash' }),
  timeout: Type.Optional(Type.Number({ description: 'Maximum seconds to wait before returning current status' })),
}, { additionalProperties: false });

const StopBackgroundBashParams = Type.Object({
  id: Type.String({ description: 'Background process id returned by bash' }),
  signal: Type.Optional(StringEnum(SIGNAL_VALUES, { description: 'Signal to send. Default: SIGTERM.' })),
}, { additionalProperties: false });

const WriteBackgroundBashParams = Type.Object({
  id: Type.String({ description: 'Background process id returned by bash' }),
  chars: Type.String({ description: 'Exact text or control bytes to write to a PTY process' }),
}, { additionalProperties: false });

type BashParams = Static<typeof BashParams>;
type ListBackgroundBashParams = Static<typeof ListBackgroundBashParams>;
type ReadBackgroundBashParams = Static<typeof ReadBackgroundBashParams>;
type WaitBackgroundBashParams = Static<typeof WaitBackgroundBashParams>;
type StopBackgroundBashParams = Static<typeof StopBackgroundBashParams>;
type WriteBackgroundBashParams = Static<typeof WriteBackgroundBashParams>;
type ExtensionUI = ExtensionContext['ui'];

interface BackgroundBashDetails {
  background: true;
  id: string;
  pid?: number;
  status: string;
  logPath: string;
  infoPath: string;
  jobDir: string;
  command: string;
  originalCommand?: string;
  rtkRewriteRemoved?: boolean;
  cwd: string;
  startedAt: number;
}

interface StatusTarget {
  ui: ExtensionUI;
  generation: number;
}

export const BACKGROUND_BASH_CONFIG = defineExtensionConfig({
  id: 'backgroundBash',
  title: 'Background processes',
  fields: {
    foregroundTimeoutSeconds: configField.number({
      default: 120,
      description: 'Seconds before a foreground Bash command is promoted to the background',
      validate: (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? undefined
        : 'must be a finite non-negative number',
    }),
  },
});

export function createBackgroundBashExtension(
  coordinator?: BackgroundBashCoordinator,
  ownsCoordinator = coordinator === undefined,
): FelanExtension {
  const extension: FelanExtension = (pi) => {
  const config = {
    foregroundTimeoutSeconds: Number(pi.config?.foregroundTimeoutSeconds ?? 120),
  };
  registerBackgroundBashCompletionRenderer(pi);
  const manager = new BackgroundBashManager(pi.runtime, coordinator);
  const foregroundBash = createRuntimeCodingTools(pi.runtime, { shellFlavor: 'posix' })
    .find((tool) => tool.name === 'bash')!;
  let helperToolsRegistered = false;
  let backgroundBashActive = false;
  let controlsRegistered = false;
  let statusTarget: StatusTarget | undefined;
  let statusPollTimer: ReturnType<typeof setInterval> | undefined;
  let statusUpdateRunning = false;
  let statusGeneration = 0;
  let completionPollingEnabled = false;
  let completionPollTimer: ReturnType<typeof setInterval> | undefined;
  let completionPollGeneration = 0;
  let completionPollRunningGeneration: number | undefined;
  let runtimeAvailable: boolean | undefined;
  let runtimeCheck: Promise<boolean> | undefined;
  const watchedJobIds = new Set<string>();

  const createStatusTarget = (ctx: ExtensionContext): StatusTarget | undefined => {
    if (ctx.mode !== 'tui') return undefined;
    return { ui: ctx.ui, generation: statusGeneration };
  };

  const updateStatus = async (target: StatusTarget | undefined) => {
    if (!target || target.generation !== statusGeneration || statusUpdateRunning) return;
    statusUpdateRunning = true;
    try {
      const running = await manager.list('running');
      if (target.generation !== statusGeneration) return;
      if (running.length === 0) {
        target.ui.setStatus('background-bash', undefined);
        return;
      }
      const label = running.length === 1 ? '1 process' : `${running.length} processes`;
      const icon = target.ui.theme.fg('accent', '●');
      const text = target.ui.theme.fg('accent', label);
      target.ui.setStatus('background-bash', `${icon} ${text}`);
    } catch {
      if (target.generation !== statusGeneration) return;
      target.ui.setStatus('background-bash', target.ui.theme.fg('warning', 'bash ?'));
    } finally {
      statusUpdateRunning = false;
    }
  };

  const startStatusPolling = (ctx: ExtensionContext) => {
    statusGeneration += 1;
    if (statusPollTimer) clearInterval(statusPollTimer);
    const target = createStatusTarget(ctx);
    statusTarget = target;
    void updateStatus(target);
    statusPollTimer = target ? setInterval(() => void updateStatus(target), 5_000) : undefined;
  };

  const stopStatusPolling = () => {
    statusGeneration += 1;
    if (statusPollTimer) {
      clearInterval(statusPollTimer);
      statusPollTimer = undefined;
    }
    statusTarget?.ui.setStatus('background-bash', undefined);
    statusTarget = undefined;
  };

  const clearCompletionPollTimer = () => {
    if (!completionPollTimer) return;
    clearInterval(completionPollTimer);
    completionPollTimer = undefined;
  };

  const deliverCompletion = (job: BackgroundBashJob) => {
    pi.sendMessage({
      customType: BACKGROUND_BASH_COMPLETION_MESSAGE_TYPE,
      content: formatCompletionNotice(job),
      display: true,
      details: { job: completionDetails(job) },
    }, {
      triggerTurn: true,
      deliverAs: 'steer',
    });
  };

  const pollCompletions = async (generation: number) => {
    if (
      generation !== completionPollGeneration
      || completionPollRunningGeneration === generation
    ) return;
    completionPollRunningGeneration = generation;
    try {
      for (const id of [...watchedJobIds]) {
        let job: BackgroundBashJob;
        try {
          job = await manager.get(id);
        } catch {
          continue;
        }
        if (
          generation !== completionPollGeneration
          || !completionPollingEnabled
          || !watchedJobIds.has(id)
        ) return;
        if (!isTerminalStatus(job.status.status)) continue;

        watchedJobIds.delete(id);
        deliverCompletion(job);
        void updateStatus(statusTarget);
      }
    } finally {
      if (completionPollRunningGeneration === generation) {
        completionPollRunningGeneration = undefined;
      }
      if (watchedJobIds.size === 0) clearCompletionPollTimer();
    }
  };

  const ensureCompletionPolling = () => {
    if (!completionPollingEnabled || watchedJobIds.size === 0 || completionPollTimer) return;
    const generation = completionPollGeneration;
    completionPollTimer = setInterval(() => void pollCompletions(generation), COMPLETION_POLL_MS);
    completionPollTimer.unref?.();
    void pollCompletions(generation);
  };

  const watchCompletion = (id: string) => {
    watchedJobIds.add(id);
    ensureCompletionPolling();
  };

  const suppressCompletion = (id: string): boolean => {
    const removed = watchedJobIds.delete(id);
    if (watchedJobIds.size === 0) clearCompletionPollTimer();
    return removed;
  };

  const resumeCompletionPolling = () => {
    completionPollingEnabled = true;
    ensureCompletionPolling();
  };

  const pauseCompletionPolling = () => {
    completionPollingEnabled = false;
    completionPollGeneration += 1;
    completionPollRunningGeneration = undefined;
    clearCompletionPollTimer();
  };

  const clearCompletionWatches = () => {
    pauseCompletionPolling();
    watchedJobIds.clear();
  };

  const openProcessView = async (ctx: ExtensionContext) => {
    if (!backgroundBashActive) {
      if (ctx.mode === 'tui') ctx.ui.notify('Background processes are unavailable in this runtime.', 'info');
      return;
    }
    const target = createStatusTarget(ctx);
    if (!target) return;
    await target.ui.custom<void>(
      (tui, theme, _keybindings, done) => new BackgroundBashView(
        manager,
        theme,
        () => done(undefined),
        () => tui.requestRender(),
      ),
    );
    await updateStatus(target);
  };

  const registerBackgroundBash = () => {
    if (backgroundBashActive) return;
    pi.registerTool({
      name: 'bash',
      label: 'bash',
      description: 'Execute a Bash command in the current working directory. Set background: true for long-running commands and inspect output with read_background_bash.',
      promptSnippet: 'Execute Bash commands, optionally as background processes with background: true',
      promptGuidelines: [
        'Use bash with background: true for long-running commands such as dev servers, watchers, and scripts the agent should not block on.',
        'Use tty: true when a command needs interactive stdin or control bytes; write_background_bash sends exact input to it.',
        'Foreground commands are promoted to the background after their timeout without restarting; timeout: 0 promotes immediately.',
        'Background process completion messages arrive automatically; continue useful work instead of polling when the current task does not need to block.',
        'After starting a background process, inspect output with read_background_bash; do not use wait_background_bash just to read output.',
        'Use wait_background_bash only when you need to wait for the process to finish or check whether it has finished.',
        'Use list_background_bash to discover processes started in this root session and workspace, including its subagents.',
      ],
      parameters: BashParams,
      async execute(_toolCallId, params: BashParams, signal, _onUpdate, ctx) {
        if (signal?.aborted) throw new Error('Command cancelled');
        const timeoutSeconds = params.timeout ?? config.foregroundTimeoutSeconds;
        const interactive = params.tty === true;
        const normalized = interactive
          ? { command: params.command, rtkRewriteRemoved: false }
          : normalizeBackgroundCommand(params.command);
        const target = createStatusTarget(ctx);
        const started = interactive
          ? await manager.startInteractive(normalized.command)
          : { job: await manager.start(normalized.command) };
        const job = started.job;
        if (signal?.aborted) {
          if (interactive) await manager.stopInteractive(job.meta.id).catch(() => {});
          else await manager.stop(job.meta.id).catch(() => {});
          throw new Error('Command cancelled');
        }
        if (!params.background && timeoutSeconds > 0) {
          try {
            if (interactive) {
              const deadline = Date.now() + timeoutSeconds * 1_000;
              let result = await manager.readInteractive(job.meta.id, Math.max(0, deadline - Date.now()), signal);
              if (signal?.aborted) throw new Error('Command cancelled');
              while (result.running && Date.now() < deadline) {
                result = await manager.readInteractive(job.meta.id, Math.max(0, deadline - Date.now()), signal);
                if (signal?.aborted) throw new Error('Command cancelled');
              }
              if (!result.running) {
                const completed = await manager.get(job.meta.id);
                return {
                  content: [{ type: 'text', text: formatForegroundOutput(completed, result.output) }],
                  details: { background: false, id: job.meta.id, status: completed.status.status, output: result.output },
                };
              }
            } else {
              const result = await manager.wait(job.meta.id, timeoutSeconds, signal);
              if (!result.timedOut) {
                const output = await manager.tail(job.meta.id);
                return {
                  content: [{ type: 'text', text: formatForegroundOutput(result.job, output) }],
                  details: { background: false, id: job.meta.id, status: result.job.status.status, output },
                };
              }
            }
          } catch (error) {
            if (signal?.aborted) {
              if (interactive) await manager.stopInteractive(job.meta.id, 'SIGTERM').catch(() => {});
              else await manager.stop(job.meta.id, 'SIGTERM').catch(() => {});
              throw new Error('Command cancelled', { cause: error });
            }
            throw error;
          }
        }
        if (!params.background) await manager.markPromoted(job.meta.id, interactive ? 'pty' : 'detached');
        watchCompletion(job.meta.id);
        await updateStatus(target);
        const notice = normalized.rtkRewriteRemoved
          ? '\n\nRTK rewrite was removed for this background process so output streams directly to the log file.'
          : '';
        const details: BackgroundBashDetails = {
          background: true,
          id: job.meta.id,
          status: job.status.status,
          logPath: job.meta.logPath,
          infoPath: job.meta.infoPath,
          jobDir: job.meta.jobDir,
          command: job.meta.command,
          cwd: job.meta.cwd,
          startedAt: job.meta.startedAt,
          ...(job.status.pid ?? job.meta.pid) === undefined
            ? {}
            : { pid: job.status.pid ?? job.meta.pid },
          ...(normalized.originalCommand === undefined
            ? {}
            : { originalCommand: normalized.originalCommand }),
          ...(normalized.rtkRewriteRemoved ? { rtkRewriteRemoved: true } : {}),
          ...(interactive ? { tty: true } : {}),
        };
        return {
          content: [{ type: 'text', text: `${formatStarted(job)}${notice}` }],
          details,
        };
      },
      renderCall(args, theme) {
        const suffix = args.background || args.tty ? theme.fg('muted', args.tty ? ' (pty)' : ' (background)') : '';
        return new Text(theme.fg('toolTitle', theme.bold(`$ ${args.command}`)) + suffix, 0, 0);
      },
    });
    backgroundBashActive = true;
  };

  const registerHelperTools = () => {
    if (helperToolsRegistered) return;
    helperToolsRegistered = true;
    pi.registerTool({
      name: 'list_background_bash',
      label: 'List background processes',
      description: 'List processes started in this root session and workspace, including processes started by its subagents.',
      promptSnippet: 'List workspace background processes and their status',
      parameters: ListBackgroundBashParams,
      async execute(_toolCallId, params: ListBackgroundBashParams, _signal, _onUpdate, ctx) {
        const target = createStatusTarget(ctx);
        const jobs = await manager.list((params.status ?? 'all') as BackgroundBashStatusFilter);
        for (const job of jobs) {
          if (isTerminalStatus(job.status.status)) suppressCompletion(job.meta.id);
        }
        await updateStatus(target);
        return {
          content: [{ type: 'text', text: formatJobList(jobs) }],
          details: { jobs: jobs.map((job) => ({ meta: job.meta, status: job.status })) },
        };
      },
    });

    pi.registerTool({
      name: 'read_background_bash',
      label: 'Read background process',
      description: 'Read the trailing output of a background process by id.',
      promptSnippet: 'Read output from a background process by id',
      parameters: ReadBackgroundBashParams,
      async execute(_toolCallId, params: ReadBackgroundBashParams, _signal, _onUpdate, ctx) {
        const output = await manager.tail(params.id, params.lines ?? 80);
        const job = await manager.get(params.id);
        if (isTerminalStatus(job.status.status)) suppressCompletion(job.meta.id);
        return {
          content: [{ type: 'text', text: output }],
          details: { id: params.id, status: job.status.status, lines: params.lines ?? 80 },
        };
      },
    });

    pi.registerTool({
      name: 'wait_background_bash',
      label: 'Wait for background process',
      description: 'Wait for a background process to finish, or return current status after a timeout. Use read_background_bash for output.',
      promptSnippet: 'Wait for a background process and return its status',
      parameters: WaitBackgroundBashParams,
      async execute(_toolCallId, params: WaitBackgroundBashParams, signal, _onUpdate, ctx) {
        const target = createStatusTarget(ctx);
        const wasWatched = suppressCompletion(params.id);
        let result: Awaited<ReturnType<BackgroundBashManager['wait']>>;
        try {
          result = await manager.wait(params.id, params.timeout, signal);
        } catch (error) {
          if (wasWatched) watchCompletion(params.id);
          throw error;
        }
        if (wasWatched && result.timedOut) watchCompletion(params.id);
        await updateStatus(target);
        return {
          content: [{ type: 'text', text: formatWaitResult(result.job, result.timedOut) }],
          details: { job: result.job, timedOut: result.timedOut },
        };
      },
    });

    pi.registerTool({
      name: 'stop_background_bash',
      label: 'Stop background process',
      description: 'Stop a running background process by id and mark it as killed.',
      promptSnippet: 'Stop a running background process by id',
      parameters: StopBackgroundBashParams,
      async execute(_toolCallId, params: StopBackgroundBashParams, _signal, _onUpdate, ctx) {
        const target = createStatusTarget(ctx);
        const wasWatched = suppressCompletion(params.id);
        let job: BackgroundBashJob;
        try {
          job = await manager.stop(params.id, params.signal ?? 'SIGTERM');
        } catch (error) {
          if (wasWatched) watchCompletion(params.id);
          throw error;
        }
        await updateStatus(target);
        return {
          content: [{ type: 'text', text: `Background process stop result.\n\n${formatJobDetails(job)}` }],
          details: { job },
        };
      },
    });

    pi.registerTool({
      name: 'write_background_bash',
      label: 'Write to background process',
      description: 'Write exact text or control bytes to a running background process with a PTY.',
      promptSnippet: 'Send stdin or control bytes to a background process with a PTY',
      parameters: WriteBackgroundBashParams,
      async execute(_toolCallId, params: WriteBackgroundBashParams, _signal, _onUpdate, ctx) {
        const result = await manager.writeInteractive(params.id, params.chars);
        const job = await manager.get(params.id);
        if (!result.running) suppressCompletion(job.meta.id);
        await updateStatus(createStatusTarget(ctx));
        return {
          content: [{ type: 'text', text: result.output || '(no output)' }],
          details: { id: params.id, status: job.status.status, tty: true },
        };
      },
    });
  };

  const registerControls = () => {
    if (controlsRegistered) return;
    controlsRegistered = true;
    pi.registerCommand('processes', {
      description: 'View processes and logs',
      handler: async (_args, ctx) => openProcessView(ctx),
    });
    pi.registerShortcut(Key.ctrlShift('j'), {
      description: 'View processes and logs',
      handler: openProcessView,
    });
  };

  const activateRegisteredTools = () => {
    if (!helperToolsRegistered || !backgroundBashActive) return;
    pi.setActiveTools([...new Set([...pi.getActiveTools(), 'bash', ...BACKGROUND_TOOL_NAMES])]);
  };

  const ensureRuntimeAvailable = async (): Promise<boolean> => {
    if (runtimeAvailable !== undefined) return runtimeAvailable;
    runtimeCheck ??= inspectBackgroundBashRuntime(pi.runtime)
      .then((status) => {
        runtimeAvailable = status.available;
        return status.available;
      })
      .finally(() => {
        runtimeCheck = undefined;
      });
    return runtimeCheck;
  };

  const enableExtension = async (ctx: ExtensionContext) => {
    if (!await ensureRuntimeAvailable()) {
      disableExtension();
      return;
    }
    registerBackgroundBash();
    registerHelperTools();
    activateRegisteredTools();
    resumeCompletionPolling();
    if (ctx.mode === 'tui') startStatusPolling(ctx);
  };

  const disableExtension = () => {
    stopStatusPolling();
    pauseCompletionPolling();
    if (!helperToolsRegistered || !backgroundBashActive) return;
    pi.registerTool({ ...foregroundBash });
    backgroundBashActive = false;
    const backgroundNames: ReadonlySet<string> = new Set(BACKGROUND_TOOL_NAMES);
    pi.setActiveTools([
      ...new Set([
        ...pi.getActiveTools().filter((name) => !backgroundNames.has(name)),
        'bash',
      ]),
    ]);
  };

  pi.on('session_start', async (_event, ctx) => {
    if (ctx.mode === 'tui') registerControls();
    await enableExtension(ctx);
  });
  pi.on('model_select', async (_event, ctx) => {
    await enableExtension(ctx);
  });
  pi.on('session_shutdown', (event) => {
    stopStatusPolling();
    clearCompletionWatches();
    return ownsCoordinator && event.reason !== 'reload' ? manager.shutdownInteractive() : undefined;
  });
  };
  associateExtensionConfig(extension, BACKGROUND_BASH_CONFIG);
  return extension;
}

const backgroundBashExtension = createBackgroundBashExtension();

export { inspectBackgroundBashRuntime } from './runtime-support.js';
export type { BackgroundBashRuntimeStatus } from './runtime-support.js';

function formatDate(ms: number | undefined): string {
  return ms ? new Date(ms).toISOString() : '-';
}

function formatDuration(job: BackgroundBashJob): string {
  const end = job.status.completedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - job.meta.startedAt) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${seconds % 60}s`;
}

function oneLine(value: string, max = 90): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function formatJobDetails(job: BackgroundBashJob): string {
  return [
    `ID: ${job.meta.id}`,
    `Status: ${job.status.status}`,
    `PID: ${job.status.pid ?? job.meta.pid ?? '-'}`,
    `Exit code: ${job.status.exitCode ?? '-'}`,
    `Signal: ${job.status.signal ?? '-'}`,
    `Error: ${job.status.error ?? '-'}`,
    `Started: ${formatDate(job.meta.startedAt)}`,
    `Completed: ${formatDate(job.status.completedAt)}`,
    `Duration: ${formatDuration(job)}`,
    `Log: ${job.meta.logPath}`,
    `Info: ${job.meta.infoPath}`,
    `Process dir: ${job.meta.jobDir}`,
    `Command: ${job.meta.command}`,
  ].join('\n');
}

function formatStarted(job: BackgroundBashJob): string {
  return `Started background process.\n\n${formatJobDetails(job)}\n\nCompletion will be delivered automatically. Use list_background_bash to see processes, read_background_bash with id "${job.meta.id}" to inspect output, wait_background_bash when the current task must block, or stop_background_bash to stop it.`;
}

function formatCompletionNotice(job: BackgroundBashJob): string {
  return `Background process reached terminal status: ${job.status.status}.\n\n${formatJobDetails(job)}\n\nUse read_background_bash with id "${job.meta.id}" if its output is needed.`;
}

function completionDetails(job: BackgroundBashJob) {
  return {
    id: job.meta.id,
    status: job.status.status,
    command: job.meta.command,
    cwd: job.meta.cwd,
    logPath: job.meta.logPath,
    infoPath: job.meta.infoPath,
    startedAt: job.meta.startedAt,
    ...(job.status.completedAt === undefined ? {} : { completedAt: job.status.completedAt }),
    ...(job.status.exitCode === undefined ? {} : { exitCode: job.status.exitCode }),
    ...(job.status.signal === undefined ? {} : { signal: job.status.signal }),
    ...(job.status.error === undefined ? {} : { error: job.status.error }),
  };
}

function formatJobList(jobs: BackgroundBashJob[]): string {
  if (jobs.length === 0) return 'No background processes found for this workspace.';
  return jobs.map((job) => {
    const pid = String(job.status.pid ?? job.meta.pid ?? '-');
    const exit = job.status.exitCode ?? job.status.signal ?? '-';
    return [
      `${job.meta.id}  ${job.status.status}  pid=${pid}  exit=${exit}  started=${formatDate(job.meta.startedAt)}  duration=${formatDuration(job)}`,
      `  log: ${job.meta.logPath}`,
      `  command: ${oneLine(job.meta.command)}`,
    ].join('\n');
  }).join('\n\n');
}

function formatWaitResult(job: BackgroundBashJob, timedOut: boolean): string {
  const heading = timedOut
    ? 'Background process is still running.'
    : 'Background process finished.';
  return `${heading}\n\n${formatJobDetails(job)}\n\nUse read_background_bash with id "${job.meta.id}" to inspect output.`;
}

function formatForegroundOutput(job: BackgroundBashJob, output: string): string {
  const exit = job.status.exitCode ?? job.status.signal ?? '-';
  return `Exit: ${exit}\n\n${output || '(no output)'}`;
}

export type { BackgroundBashDetails };
export { BackgroundBashManager } from './process-manager.js';
export { BackgroundBashCoordinator } from './coordinator.js';
export type { InteractiveBashProcess } from './coordinator.js';
export type {
  BackgroundBashInfo,
  BackgroundBashJob,
  BackgroundBashMeta,
  BackgroundBashStatus,
  BackgroundBashStatusFile,
  BackgroundBashStatusFilter,
} from './job-store.js';
export default backgroundBashExtension;
associateExtensionConfig(backgroundBashExtension, BACKGROUND_BASH_CONFIG);
