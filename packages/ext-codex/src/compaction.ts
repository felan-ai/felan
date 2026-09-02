import type { ExtensionContext, FelanExtensionAPI } from '@felan-ai/agent-core';
import type { CodexConfig } from './config.js';
import { supportsCodexModel } from './model-policy.js';

export function registerPostAgentRunCompaction(
  pi: FelanExtensionAPI,
  config: CodexConfig,
): void {
  let deferred = false;
  let activeCompaction: object | undefined;

  pi.on('session_before_compact', (event, ctx) => {
    if (event.reason !== 'threshold') {
      deferred = false;
      return undefined;
    }
    if (activeCompaction) return { cancel: true };
    if (!shouldDefer(event.reason, ctx, config)) return undefined;
    deferred = true;
    return { cancel: true };
  });

  pi.on('agent_settled', (_event, ctx) => {
    if (!deferred) return;
    deferred = false;
    if (!supportsCodexModel(ctx.model)) return;
    const operation = {};
    activeCompaction = operation;
    ctx.compact({
      onComplete: () => {
        if (activeCompaction === operation) activeCompaction = undefined;
      },
      onError: (error) => {
        if (activeCompaction !== operation) return;
        activeCompaction = undefined;
        if (!isAbortError(error)) {
          ctx.ui.notify(`Post-agent GPT compaction failed: ${error.message}`, 'error');
        }
      },
    });
  });

  pi.on('session_start', () => {
    deferred = false;
    activeCompaction = undefined;
  });
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
