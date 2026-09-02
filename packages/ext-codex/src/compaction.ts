import type { ExtensionContext, FelanExtensionAPI } from '@felan-ai/agent-core';
import type { CodexConfig } from './config.js';
import { supportsCodexModel } from './model-policy.js';

export function registerPostAgentRunCompaction(
  pi: FelanExtensionAPI,
  config: CodexConfig,
): void {
  let deferred = false;

  pi.on('session_before_compact', (event, ctx) => {
    if (!shouldDefer(event.reason, ctx, config)) return undefined;
    deferred = true;
    return { cancel: true };
  });

  pi.on('agent_settled', (_event, ctx) => {
    if (!deferred) return;
    deferred = false;
    if (!supportsCodexModel(ctx.model)) return;
    ctx.compact({
      onError: (error) => {
        ctx.ui.notify(`Post-agent GPT compaction failed: ${error.message}`, 'error');
      },
    });
  });

  pi.on('session_start', () => {
    deferred = false;
  });
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
