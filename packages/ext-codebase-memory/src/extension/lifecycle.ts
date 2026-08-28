import type { ExtensionContext, FelanExtensionAPI } from '@felan-ai/agent-core';
import type { CbmAugmentService } from './augment.js';
import type { ProjectService } from '../domain/project.js';
import { CODEBASE_MEMORY_PROMPT } from './prompt.js';
import type { CodebaseMemorySessionState } from './session-state.js';

export function registerLifecycle(
  pi: FelanExtensionAPI,
  services: { projects: ProjectService; augment?: CbmAugmentService; state: CodebaseMemorySessionState },
): void {
  pi.on('before_agent_start', async (event) => services.state.disabled ? undefined : { systemPrompt: event.systemPrompt + CODEBASE_MEMORY_PROMPT });
  pi.on('session_start', (_event, ctx) => {
    if (services.state.disabled) return;
    ctx.ui.setStatus('codebase-memory', 'cbm: idx');
    void runStartupIndex(pi, services, ctx).catch(() => undefined);
  });
  if (services.augment) {
    pi.on('tool_result', async (event, ctx) => {
      if (services.state.disabled) return;
      const result = await services.augment!.augmentResult(event as never, { cwd: ctx.cwd, signal: ctx.signal });
      pi.appendEntry('codebase-memory-telemetry', { event: 'augmentation', status: result.status, tool: event.toolName });
      if (result.status === 'matched') event.content = result.content as never;
    });
  }
}

async function runStartupIndex(
  pi: FelanExtensionAPI,
  services: { projects: ProjectService; state: CodebaseMemorySessionState },
  ctx: ExtensionContext,
): Promise<void> {
  try {
    const result = await services.projects.indexCurrentRepo(ctx.cwd, ctx.signal);
    ctx.ui.setStatus('codebase-memory', result.status === 'skipped' ? 'cbm: off' : 'cbm: on');
  } catch (error) {
    services.state.disable();
    try { ctx.ui.setStatus('codebase-memory', 'cbm: off'); } catch {}
    try {
      pi.appendEntry('codebase-memory-telemetry', {
        event: 'init_error',
        error: error instanceof Error ? error.message : String(error),
      });
    } catch {}
  }
}
