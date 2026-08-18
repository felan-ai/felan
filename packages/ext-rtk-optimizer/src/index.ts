import type { AgentRuntime, ExtensionContext, FelanExtension } from '@felan-ai/agent-core';
import { registerRtkCommand } from './command.js';
import { computeRewriteDecision, inspectRtkRuntime } from './command-rewriter.js';
import { loadRtkOptimizerConfig, saveRtkOptimizerConfig } from './config.js';
import { installManagedRtk } from './installer.js';
import { compactToolResult, type ToolResultCompactionMetadata } from './output-compactor.js';
import { OutputMetrics } from './output-metrics.js';
import { toRecord } from './record-utils.js';
import { sanitizeStreamingCommandResult } from './tool-execution-sanitizer.js';
import {
  codexResultHasExited,
  isCommandToolName,
  isStreamingCommandToolName,
  readCodexSessionId,
  readRunningCodexSessionId,
  readToolCommand,
  writeToolCommand,
} from './tool-shapes.js';
import type { RtkOptimizerConfig, RuntimeStatus } from './types.js';

const EXTENSION_NAME = 'RTK optimizer';
const RUNTIME_STATUS_MAX_AGE_MS = 30_000;
const SOURCE_FILTER_TROUBLESHOOTING_NOTE =
  "RTK note: If file edits repeatedly fail because old text does not match, run '/rtk', disable lossy read compaction, re-read the file, apply the edit, and then re-enable compaction if desired.";
const activeRuntimeRefreshers = new WeakMap<AgentRuntime, () => Promise<RuntimeStatus>>();

export async function refreshActiveRtkRuntime(runtime: AgentRuntime): Promise<RuntimeStatus> {
  return activeRuntimeRefreshers.get(runtime)?.() ?? inspectRtkRuntime(runtime);
}

const rtkOptimizerExtension: FelanExtension = async (pi) => {
  const initialLoad = await loadRtkOptimizerConfig(pi.runtime);
  let config = initialLoad.config;
  let pendingConfigWarning = initialLoad.warning;
  let runtimeStatus: RuntimeStatus = { rtkAvailable: false };
  let statusRefresh: Promise<RuntimeStatus> | undefined;
  let missingRtkWarningShown = false;

  const metrics = new OutputMetrics();
  const warnedMessages = createBoundedNoticeTracker(100);
  const suggestionNotices = createBoundedNoticeTracker(200);
  const codexSessionCommands = new Map<number, string>();
  const activeCodexCommands = new Map<string, string>();

  const refreshRuntimeStatus = (): Promise<RuntimeStatus> => {
    statusRefresh ??= inspectRtkRuntime(pi.runtime)
      .then((status) => {
        runtimeStatus = status;
        if (status.rtkAvailable) missingRtkWarningShown = false;
        return status;
      })
      .finally(() => {
        statusRefresh = undefined;
      });
    return statusRefresh;
  };
  activeRuntimeRefreshers.set(pi.runtime, refreshRuntimeStatus);

  const ensureRuntimeStatusFresh = async (): Promise<void> => {
    if (!config.guardWhenRtkMissing) return;
    if (
      runtimeStatus.lastCheckedAt === undefined ||
      Date.now() - runtimeStatus.lastCheckedAt > RUNTIME_STATUS_MAX_AGE_MS
    ) {
      await refreshRuntimeStatus();
    }
  };

  const warnOnce = (ctx: ExtensionContext, message: string, level: 'warning' | 'error' = 'warning'): void => {
    if (!warnedMessages.remember(message)) return;
    ctx.ui.notify(message, level);
  };

  const maybeWarnRtkMissing = (ctx: ExtensionContext): void => {
    if (!config.enabled || !config.guardWhenRtkMissing || runtimeStatus.rtkAvailable || missingRtkWarningShown) return;

    missingRtkWarningShown = true;
    const reason = runtimeStatus.lastError ? ` (${runtimeStatus.lastError})` : '';
    warnOnce(ctx, `${EXTENSION_NAME}: rtk is unavailable; command rewriting is bypassed${reason}.`);
  };

  registerRtkCommand(pi, {
    getConfig: () => config,
    setConfig: async (next) => {
      config = await saveRtkOptimizerConfig(pi.runtime, next);
    },
    getRuntimeStatus: () => runtimeStatus,
    refreshRuntimeStatus,
    install: async (onStatus) => {
      const status = await installManagedRtk(pi.runtime, onStatus);
      runtimeStatus = status;
      if (status.rtkAvailable) missingRtkWarningShown = false;
      return status;
    },
    getMetricsSummary: () => metrics.summary(),
    clearMetrics: () => metrics.clear(),
  });

  pi.on('session_start', async (_event, ctx) => {
    warnedMessages.reset();
    suggestionNotices.reset();
    codexSessionCommands.clear();
    activeCodexCommands.clear();
    metrics.clear();
    missingRtkWarningShown = false;

    const loaded = await loadRtkOptimizerConfig(pi.runtime);
    config = loaded.config;
    pendingConfigWarning = loaded.warning ?? pendingConfigWarning;
    if (pendingConfigWarning) {
      warnOnce(ctx, pendingConfigWarning);
      pendingConfigWarning = undefined;
    }
    if (config.enabled) {
      await refreshRuntimeStatus();
      maybeWarnRtkMissing(ctx);
    }
  });

  pi.on('session_shutdown', () => {
    if (activeRuntimeRefreshers.get(pi.runtime) === refreshRuntimeStatus) {
      activeRuntimeRefreshers.delete(pi.runtime);
    }
    codexSessionCommands.clear();
    activeCodexCommands.clear();
  });

  pi.on('agent_end', () => {
    activeCodexCommands.clear();
  });

  pi.on('before_agent_start', async (event, ctx) => {
    if (!config.enabled) return undefined;
    await ensureRuntimeStatusFresh();
    maybeWarnRtkMissing(ctx);

    if (!shouldInjectSourceFilterTroubleshootingNote(config)) return undefined;
    const systemPrompt = injectGuidelineIntoPrompt(event.systemPrompt, SOURCE_FILTER_TROUBLESHOOTING_NOTE);
    return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
  });

  pi.on('tool_call', async (event, ctx) => {
    if (!config.enabled || !isCommandToolName(event.toolName)) return undefined;
    const command = readToolCommand(event.toolName, event.input);
    if (!command) return undefined;

    await ensureRuntimeStatusFresh();
    if (config.guardWhenRtkMissing && !runtimeStatus.rtkAvailable) {
      maybeWarnRtkMissing(ctx);
      return undefined;
    }

    const decision = await computeRewriteDecision(pi.runtime, command, {
      ...(runtimeStatus.command === undefined ? {} : { executable: runtimeStatus.command }),
    });
    if (!decision.changed) {
      if (decision.warning) {
        warnOnce(
          ctx,
          `${EXTENSION_NAME}: rtk rewrite skipped for '${trimMessage(command, 100)}' (${trimMessage(decision.warning)}).`,
        );
      }
      return undefined;
    }

    if (config.mode === 'rewrite') {
      writeToolCommand(event.toolName, event.input, decision.rewrittenCommand);
      if (config.showRewriteNotifications && ctx.hasUI) {
        ctx.ui.notify(
          `RTK rewrite: ${trimMessage(command, 100)} -> ${trimMessage(decision.rewrittenCommand, 120)}`,
          'info',
        );
      }
      return undefined;
    }

    const suggestionKey = `${command}:${decision.rewrittenCommand}`;
    if (suggestionNotices.remember(suggestionKey) && ctx.hasUI) {
      ctx.ui.notify(`RTK suggestion: ${decision.rewrittenCommand}`, 'info');
    }
    return undefined;
  });

  pi.on('tool_execution_start', (event) => {
    if (event.toolName !== 'exec_command') return;
    const command = readToolCommand(event.toolName, event.args);
    if (command) activeCodexCommands.set(event.toolCallId, command);
  });

  pi.on('tool_execution_update', (event) => {
    recordCodexSessionFromExecution(
      event.toolName,
      event.toolCallId,
      event.partialResult,
      activeCodexCommands,
      codexSessionCommands,
    );
    if (
      !config.enabled ||
      !config.outputCompaction.enabled ||
      !config.outputCompaction.stripAnsi ||
      !isStreamingCommandToolName(event.toolName)
    )
      return;

    sanitizeStreamingCommandResult(event.partialResult);
  });

  pi.on('tool_execution_end', (event) => {
    recordCodexSessionFromExecution(
      event.toolName,
      event.toolCallId,
      event.result,
      activeCodexCommands,
      codexSessionCommands,
    );
    activeCodexCommands.delete(event.toolCallId);
    if (
      !config.enabled ||
      !config.outputCompaction.enabled ||
      !config.outputCompaction.stripAnsi ||
      !isStreamingCommandToolName(event.toolName)
    )
      return;

    sanitizeStreamingCommandResult(event.result);
  });

  pi.on('tool_result', async (event, ctx) => {
    const originatingCommand = commandForResult(event.toolName, event.input, codexSessionCommands);
    updateCodexSessionCommands(event.toolName, event.input, event.details, originatingCommand, codexSessionCommands);

    if (!config.enabled || !config.outputCompaction.enabled) return undefined;

    try {
      const outcome = compactToolResult(
        {
          toolName: event.toolName,
          input: event.input,
          content: event.content,
        },
        config,
        {
          cwd: ctx.cwd,
          agentDir: pi.agentDir,
          ...(originatingCommand === undefined ? {} : { command: originatingCommand }),
          metrics,
        },
      );
      if (!outcome.changed || !outcome.content) return undefined;
      return {
        content: outcome.content as typeof event.content,
        ...(outcome.metadata === undefined ? {} : { details: mergeCompactionDetails(event.details, outcome.metadata) }),
      };
    } catch (error) {
      warnOnce(
        ctx,
        `${EXTENSION_NAME}: output compaction failed; using raw output (${trimMessage(errorMessage(error))}).`,
      );
      return undefined;
    }
  });
};

export function shouldInjectSourceFilterTroubleshootingNote(config: RtkOptimizerConfig): boolean {
  const compaction = config.outputCompaction;
  return (
    config.enabled &&
    compaction.enabled &&
    compaction.readCompaction.enabled &&
    compaction.sourceCodeFilteringEnabled &&
    compaction.sourceCodeFiltering !== 'none' &&
    (compaction.smartTruncate.enabled || compaction.truncate.enabled)
  );
}

export function injectGuidelineIntoPrompt(systemPrompt: string, guideline: string): string {
  if (!systemPrompt || systemPrompt.includes(guideline)) return systemPrompt;
  const bullet = `- ${guideline}`;
  const header = 'Guidelines:\n';
  let headerIndex = systemPrompt.indexOf(`\n${header}`);
  let contentStart: number;
  if (headerIndex >= 0) {
    contentStart = headerIndex + header.length + 1;
  } else if (systemPrompt.startsWith(header)) {
    headerIndex = 0;
    contentStart = header.length;
  } else {
    return `${systemPrompt}\n\n${guideline}`;
  }

  const remainder = systemPrompt.slice(contentStart);
  let consumed = 0;
  for (const line of remainder.split('\n')) {
    if (!line || !/^[-*+\s]/u.test(line)) break;
    consumed += line.length + 1;
  }
  const insertAt = consumed === 0 ? contentStart : contentStart + consumed - 1;
  const before = systemPrompt.slice(0, insertAt);
  const after = systemPrompt.slice(insertAt);
  return `${before}${before.endsWith('\n') ? '' : '\n'}${bullet}${after.startsWith('\n') ? '' : '\n'}${after}`;
}

function commandForResult(
  toolName: string,
  input: unknown,
  codexSessionCommands: ReadonlyMap<number, string>,
): string | undefined {
  if (isCommandToolName(toolName)) return readToolCommand(toolName, input);
  if (toolName !== 'write_stdin') return undefined;
  const sessionId = readCodexSessionId(input);
  return sessionId === undefined ? undefined : codexSessionCommands.get(sessionId);
}

function recordCodexSessionFromExecution(
  toolName: string,
  toolCallId: string,
  result: unknown,
  activeCodexCommands: ReadonlyMap<string, string>,
  codexSessionCommands: Map<number, string>,
): void {
  if (toolName !== 'exec_command') return;
  const command = activeCodexCommands.get(toolCallId);
  if (!command) return;
  const sessionId = readRunningCodexSessionId(toRecord(result).details);
  if (sessionId !== undefined) codexSessionCommands.set(sessionId, command);
}

function updateCodexSessionCommands(
  toolName: string,
  input: unknown,
  details: unknown,
  command: string | undefined,
  codexSessionCommands: Map<number, string>,
): void {
  if (toolName === 'exec_command' && command) {
    const runningSessionId = readRunningCodexSessionId(details);
    if (runningSessionId !== undefined) codexSessionCommands.set(runningSessionId, command);
    return;
  }
  if (toolName !== 'write_stdin') return;

  const requestedSessionId = readCodexSessionId(input);
  if (requestedSessionId === undefined) return;
  if (codexResultHasExited(details)) codexSessionCommands.delete(requestedSessionId);
}

function mergeCompactionDetails(
  existingDetails: unknown,
  compaction: ToolResultCompactionMetadata,
): Record<string, unknown> {
  const base = toRecord(existingDetails);
  const metadata = toRecord(base.metadata);
  return {
    ...base,
    rtkCompaction: compaction,
    metadata: { ...metadata, rtkCompaction: compaction },
    ...(Object.keys(base).length === 0 && existingDetails !== undefined ? { rawDetails: existingDetails } : {}),
  };
}

export interface BoundedNoticeTracker {
  remember(key: string): boolean;
  reset(): void;
}

export function createBoundedNoticeTracker(maxEntries: number): BoundedNoticeTracker {
  const limit = Math.max(1, Math.floor(maxEntries));
  const seen = new Set<string>();
  const order: string[] = [];
  return {
    remember(key) {
      if (seen.has(key)) return false;
      seen.add(key);
      order.push(key);
      while (order.length > limit) {
        const evicted = order.shift();
        if (evicted !== undefined) seen.delete(evicted);
      }
      return true;
    },
    reset() {
      seen.clear();
      order.length = 0;
    },
  };
}

function trimMessage(value: string, maxLength = 220): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export {
  getRtkOptimizerConfigPath,
  loadRtkOptimizerConfig,
  saveRtkOptimizerConfig,
  validateRtkOptimizerConfig,
} from './config.js';
export { computeRewriteDecision, inspectRtkRuntime, resolveRtkRewrite } from './command-rewriter.js';
export {
  installManagedRtk,
  managedRtkDirectory,
  managedRtkExecutable,
  MANAGED_RTK_VERSION,
  supportsManagedRtk,
} from './installer.js';
export { compactToolResult } from './output-compactor.js';
export { OutputMetrics } from './output-metrics.js';
export { DEFAULT_RTK_OPTIMIZER_CONFIG } from './types.js';
export type {
  RtkMode,
  RtkOptimizerConfig,
  RtkOutputCompactionConfig,
  RtkSourceFilterLevel,
  RuntimeStatus,
} from './types.js';
export default rtkOptimizerExtension;
