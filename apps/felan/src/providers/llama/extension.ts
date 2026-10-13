import type { ExtensionContext, ExtensionFactory } from '@felan-ai/agent-core';
import { manageLlamaModels } from './management.js';
import { createLlamaPresentation, type LlamaPresentation } from './presentation.js';
import { loadLlamaSdk, type LlamaSdk } from './sdk.js';

export function createLlamaExtension(options: {
  loadSdk?: () => Promise<LlamaSdk>;
  presentation?: (ui: ExtensionContext['ui'], signal: AbortSignal) => LlamaPresentation;
} = {}): ExtensionFactory {
  return async pi => {
    const sdk = await (options.loadSdk ?? loadLlamaSdk)();
    const provider = sdk.createLlamaProvider();
    const lifetime = new AbortController();
    const active = new Set<Promise<void>>();
    pi.registerProvider(provider.provider);
    pi.registerCommand('llama', { description: 'Manage llama.cpp router models', handler: async (_args, ctx) => {
      lifetime.signal.throwIfAborted();
      if (!ctx.hasUI) { ctx.ui.notify('/llama requires an interactive client', 'warning'); return; }
      const ui = (options.presentation ?? createLlamaPresentation)(ctx.ui, lifetime.signal);
      const work = manageLlamaModels(ctx, sdk, provider, ui, lifetime.signal)
        .catch(error => { if (!lifetime.signal.aborted) throw error; })
        .finally(() => ui.dispose());
      active.add(work);
      try { await work; } finally { active.delete(work); }
    } });
    pi.on('session_shutdown', async () => { lifetime.abort(); await Promise.all([...active]); });
  };
}

export default createLlamaExtension();
