import {
  StringEnum,
  createRuntimeCodingTools,
  type Api,
  type ExtensionContext,
  type FelanExtension,
  type Model,
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
import { inspectBackgroundBashRuntime } from './runtime-support.js';
import { BackgroundBashOverlay } from './ui/background-bash-overlay.js';

const STATUS_VALUES = ['running', 'completed', 'failed', 'killed', 'unknown', 'all'] as const;
const SIGNAL_VALUES = ['SIGTERM', 'SIGKILL'] as const;
const OPENAI_PROVIDER_IDS: ReadonlySet<string> = new Set(['openai', 'openai-codex']);
const COMPLETION_MESSAGE_TYPE = 'felan-background-bash-completion';
const COMPLETION_POLL_MS = 500;
const BACKGROUND_TOOL_NAMES = [
  'list_background_bash',
  'read_background_bash',
  'wait_background_bash',
  'stop_background_bash',
] as const;

const BashParams = Type.Object({
  command: Type.String({ description: 'Bash command to execute' }),
  timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds for foreground commands' })),
  background: Type.Optional(Type.Boolean({
    description: 'Start a detached background Bash process and return immediately',
  })),
}, { additionalProperties: false });

const ListBackgroundBashParams = Type.Object({
  status: Type.Optional(StringEnum(STATUS_VALUES, { description: 'Filter processes by status' })),
}, { additionalProperties: false });

const ReadBackgroundBashParams = Type.Object({
  id: Type.String({ description: 'Background Bash process id returned by bash(background: true)' }),
  lines: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 1_000,
    description: 'Number of trailing log lines to return. Default: 80.',
  })),
}, { additionalProperties: false });

const WaitBackgroundBashParams = Type.Object({
  id: Type.String({ description: 'Background Bash process id returned by bash(background: true)' }),
  timeout: Type.Optional(Type.Number({ description: 'Maximum seconds to wait before returning current status' })),
}, { additionalProperties: false });

const StopBackgroundBashParams = Type.Object({
  id: Type.String({ description: 'Background Bash process id returned by bash(background: true)' }),
  signal: Type.Optional(StringEnum(SIGNAL_VALUES, { description: 'Signal to send. Default: SIGTERM.' })),
}, { additionalProperties: false });

type BashParams = Static<typeof BashParams>;
type ListBackgroundBashParams = Static<typeof ListBackgroundBashParams>;
type ReadBackgroundBashParams = Static<typeof ReadBackgroundBashParams>;
type WaitBackgroundBashParams = Static<typeof WaitBackgroundBashParams>;
type StopBackgroundBashParams = Static<typeof StopBackgroundBashParams>;
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

export function supportsBackgroundBashModel(model: Model<Api> | undefined): boolean {
  return model !== undefined && !OPENAI_PROVIDER_IDS.has(model.provider);
}

const backgroundBashExtension: FelanExtension = (pi) => {
  const manager = new BackgroundBashManager(pi.runtime);
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
      customType: COMPLETION_MESSAGE_TYPE,
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

  const openOverlay = async (ctx: ExtensionContext) => {
    if (!supportsBackgroundBashModel(ctx.model)) {
      if (ctx.mode === 'tui') ctx.ui.notify('Background Bash is unavailable for this model.', 'info');
      return;
    }
    const target = createStatusTarget(ctx);
    if (!target) return;
    await target.ui.custom<void>(
      (tui, theme, _keybindings, done) => new BackgroundBashOverlay(
        manager,
        theme,
        () => done(undefined),
        () => tui.requestRender(),
      ),
      {
        overlay: true,
        overlayOptions: {
          width: '85%',
          minWidth: 72,
          maxHeight: '90%',
          margin: 2,
        },
      },
    );
    await updateStatus(target);
  };

  const assertSupportedModel = (ctx: ExtensionContext) => {
    if (!supportsBackgroundBashModel(ctx.model)) {
      throw new Error('Background Bash is unavailable for this model.');
    }
  };

  const registerBackgroundBash = () => {
    if (backgroundBashActive) return;
    pi.registerTool({
      name: 'bash',
      label: 'bash',
      description: 'Execute a Bash command in the current working directory. Set background: true for long-running commands and inspect output with read_background_bash.',
      promptSnippet: 'Execute Bash commands, optionally as detached processes with background: true',
      promptGuidelines: [
        'Use bash with background: true for long-running commands such as dev servers, watchers, and scripts the agent should not block on.',
        'Background Bash completion messages arrive automatically; continue useful work instead of polling when the current task does not need to block.',
        'After starting Background Bash, inspect output with read_background_bash; do not use wait_background_bash just to read output.',
        'Use wait_background_bash only when you need to wait for the process to finish or check whether it has finished.',
        'Use list_background_bash to discover detached Bash processes started in this root session and workspace, including its subagents.',
      ],
      parameters: BashParams,
      async execute(toolCallId, params: BashParams, signal, onUpdate, ctx) {
        if (!params.background) {
          return foregroundBash.execute(
            toolCallId,
            {
              command: params.command,
              ...(params.timeout === undefined ? {} : { timeout: params.timeout }),
            },
            signal,
            onUpdate,
            ctx,
          );
        }

        assertSupportedModel(ctx);
        const normalized = normalizeBackgroundCommand(params.command);
        const target = createStatusTarget(ctx);
        const job = await manager.start(normalized.command);
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
        };
        return {
          content: [{ type: 'text', text: `${formatStarted(job)}${notice}` }],
          details,
        };
      },
      renderCall(args, theme) {
        const suffix = args.background ? theme.fg('muted', ' (background)') : '';
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
      label: 'List Background Bash',
      description: 'List detached Bash processes started in this root session and workspace, including processes started by its subagents.',
      promptSnippet: 'List workspace Background Bash processes and their status',
      parameters: ListBackgroundBashParams,
      async execute(_toolCallId, params: ListBackgroundBashParams, _signal, _onUpdate, ctx) {
        assertSupportedModel(ctx);
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
      label: 'Read Background Bash',
      description: 'Read the trailing output of a detached Bash process by id.',
      promptSnippet: 'Read output from a Background Bash process by id',
      parameters: ReadBackgroundBashParams,
      async execute(_toolCallId, params: ReadBackgroundBashParams, _signal, _onUpdate, ctx) {
        assertSupportedModel(ctx);
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
      label: 'Wait Background Bash',
      description: 'Wait for a detached Bash process to finish, or return current status after a timeout. Use read_background_bash for output.',
      promptSnippet: 'Wait for a Background Bash process and return its status',
      parameters: WaitBackgroundBashParams,
      async execute(_toolCallId, params: WaitBackgroundBashParams, signal, _onUpdate, ctx) {
        assertSupportedModel(ctx);
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
      label: 'Stop Background Bash',
      description: 'Stop a running Background Bash process by id and mark it as killed.',
      promptSnippet: 'Stop a running Background Bash process by id',
      parameters: StopBackgroundBashParams,
      async execute(_toolCallId, params: StopBackgroundBashParams, _signal, _onUpdate, ctx) {
        assertSupportedModel(ctx);
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
          content: [{ type: 'text', text: `Background Bash stop result.\n\n${formatJobDetails(job)}` }],
          details: { job },
        };
      },
    });
  };

  const registerControls = () => {
    if (controlsRegistered) return;
    controlsRegistered = true;
    pi.registerCommand('background-bash', {
      description: 'View Background Bash processes and logs',
      handler: async (_args, ctx) => openOverlay(ctx),
    });
    pi.registerShortcut(Key.ctrlShift('j'), {
      description: 'View Background Bash processes and logs',
      handler: openOverlay,
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
    if (!supportsBackgroundBashModel(ctx.model)) {
      stopStatusPolling();
      pauseCompletionPolling();
      return;
    }
    if (!await ensureRuntimeAvailable()) {
      disableExtension();
      return;
    }
    registerBackgroundBash();
    registerHelperTools();
    activateRegisteredTools();
    resumeCompletionPolling();
    if (ctx.mode === 'tui') {
      registerControls();
      startStatusPolling(ctx);
    }
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

  pi.on('session_start', (_event, ctx) => enableExtension(ctx));
  pi.on('model_select', async (event, ctx) => {
    if (supportsBackgroundBashModel(event.model)) await enableExtension(ctx);
    else disableExtension();
  });
  pi.on('session_shutdown', () => {
    stopStatusPolling();
    clearCompletionWatches();
  });
};

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
  return `Started Background Bash process.\n\n${formatJobDetails(job)}\n\nCompletion will be delivered automatically. Use list_background_bash to see processes, read_background_bash with id "${job.meta.id}" to inspect output, wait_background_bash when the current task must block, or stop_background_bash to stop it.`;
}

function formatCompletionNotice(job: BackgroundBashJob): string {
  return `Background Bash process reached terminal status: ${job.status.status}.\n\n${formatJobDetails(job)}\n\nUse read_background_bash with id "${job.meta.id}" if its output is needed.`;
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
  if (jobs.length === 0) return 'No Background Bash processes found for this workspace.';
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
    ? 'Background Bash process is still running.'
    : 'Background Bash process finished.';
  return `${heading}\n\n${formatJobDetails(job)}\n\nUse read_background_bash with id "${job.meta.id}" to inspect output.`;
}

export type { BackgroundBashDetails };
export { BackgroundBashManager } from './process-manager.js';
export type {
  BackgroundBashInfo,
  BackgroundBashJob,
  BackgroundBashMeta,
  BackgroundBashStatus,
  BackgroundBashStatusFile,
  BackgroundBashStatusFilter,
} from './job-store.js';
export default backgroundBashExtension;
