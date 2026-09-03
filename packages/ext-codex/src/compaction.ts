import type { ExtensionContext, FelanExtensionAPI } from '@felan-ai/agent-core';
import type { CodexConfig } from './config.js';
import { supportsCodexModel } from './model-policy.js';

export function registerPostAgentRunCompaction(
  pi: FelanExtensionAPI,
  config: CodexConfig,
): void {
  let deferredAgentRun: number | undefined;
  let activeCompaction: { agentRun: number } | undefined;
  let agentRun = 0;
  let compactionAttemptAgentRun: number | undefined;
  let pendingPiCompactionAgentRun: number | undefined;

  const startDeferredCompaction = (ctx: ExtensionContext): void => {
    if (deferredAgentRun !== agentRun) return;
    if (compactionAttemptAgentRun === agentRun) {
      deferredAgentRun = undefined;
      return;
    }
    if (activeCompaction) return;

    deferredAgentRun = undefined;
    if (!supportsCodexModel(ctx.model)) return;
    const operation = { agentRun };
    activeCompaction = operation;
    compactionAttemptAgentRun = agentRun;
    ctx.compact({
      onComplete: () => {
        if (activeCompaction !== operation) return;
        activeCompaction = undefined;
        if (ctx.isIdle()) startDeferredCompaction(ctx);
      },
      onError: (error) => {
        if (activeCompaction !== operation) return;
        activeCompaction = undefined;
        if (!isAbortError(error)) {
          ctx.ui.notify(`Post-agent GPT compaction failed: ${error.message}`, 'error');
        }
        if (ctx.isIdle()) startDeferredCompaction(ctx);
      },
    });
  };

  pi.on('session_before_compact', (event, ctx) => {
    if (event.reason !== 'threshold') {
      if (deferredAgentRun === agentRun) deferredAgentRun = undefined;
      pendingPiCompactionAgentRun = agentRun;
      return undefined;
    }
    if (!shouldDefer(event.reason, ctx, config)) {
      pendingPiCompactionAgentRun = agentRun;
      return undefined;
    }
    if (compactionAttemptAgentRun !== agentRun) deferredAgentRun = agentRun;
    return { cancel: true };
  });

  pi.on('agent_settled', (_event, ctx) => {
    startDeferredCompaction(ctx);
  });

  pi.on('agent_start', () => {
    agentRun += 1;
  });

  pi.on('session_compact', (event, ctx) => {
    if (pendingPiCompactionAgentRun === undefined
      || !isCurrentSessionCompaction(event.compactionEntry, ctx)) return;
    const completedAgentRun = pendingPiCompactionAgentRun;
    pendingPiCompactionAgentRun = undefined;
    if (deferredAgentRun === completedAgentRun) deferredAgentRun = undefined;
    if (completedAgentRun === agentRun) compactionAttemptAgentRun = completedAgentRun;
  });

  pi.on('session_start', () => {
    deferredAgentRun = undefined;
    activeCompaction = undefined;
    agentRun += 1;
    compactionAttemptAgentRun = undefined;
    pendingPiCompactionAgentRun = undefined;
  });
}

function isCurrentSessionCompaction(
  entry: { id: string },
  ctx: ExtensionContext,
): boolean {
  try {
    return ctx.sessionManager.getEntry(entry.id) === entry;
  } catch {
    return false;
  }
}

function isAbortError(error: Error): boolean {
  return error.name === 'AbortError'
    || /(?:operation was aborted|compaction cancelled)$/iu.test(error.message);
}

function shouldDefer(
  reason: 'manual' | 'threshold' | 'overflow',
  ctx: ExtensionContext,
  config: CodexConfig,
): boolean {
  return config.postAgentRunCompaction
    && reason === 'threshold'
    && !ctx.isIdle()
    && supportsCodexModel(ctx.model);
}
