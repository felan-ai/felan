import type { ModelReference, ModelRuntime, SessionRef } from '@felan-ai/agent-core';
import type { ProviderWorkerLauncher, ProviderWorkerSession } from './provider.js';
import type { SessionRegistry } from './registry.js';

export function createRegisteredWorkerLauncher(registry: SessionRegistry, current: SessionRef, modelRuntime: ModelRuntime,
  allowedModels?: readonly ModelReference[]): ProviderWorkerLauncher {
  return async request => {
    registry.assertNewWork(); registry.assertDispatch(current.id);
    if (!request || !request.model || !request.runtime || !request.sessionManager || !request.settingsManager) throw new Error('Worker request is invalid.');
    request.signal?.throwIfAborted();
    const selected = { provider: request.model.provider, id: request.model.id };
    const allowedTools = [...request.allowedTools];
    if (allowedModels && !allowedModels.some(model => model.provider === selected.provider && model.id === selected.id)) throw new Error('Worker model is outside the current scope.');
    const available = await modelRuntime.getAvailable(selected.provider, request.signal ? { signal: request.signal } : {});
    request.signal?.throwIfAborted();
    const model = available.find(value => value.id === selected.id && value.provider === selected.provider);
    if (!model) throw new Error('Worker model is unavailable.');
    registry.assertNewWork(); registry.assertDispatch(current.id);
    const binding = await registry.openWorker(current.id, { ...request, allowedTools, model, modelRuntime });
    if (request.signal?.aborted) { await registry.close(binding.sessionId); request.signal.throwIfAborted(); }
    const session = binding.runtime.session;
    const allowed = new Set(allowedTools);
    return {
      dispose: () => registry.close(binding.sessionId),
      abort: () => session.abort(),
      subscribe: listener => session.subscribe(listener),
      get messages() { return session.messages; },
      get thinkingLevel() { return session.thinkingLevel; },
      getActiveToolNames: () => session.getActiveToolNames(),
      prompt: async (...args: Parameters<typeof session.prompt>) => {
        registry.assertNewWork(); registry.assertDispatch(current.id); registry.assertDispatch(binding.sessionId);
        registry.projection(binding.sessionId).setOrigin({ kind: 'automation', source: 'worker' });
        return registry.runWorker(binding.sessionId, () => session.prompt(...args));
      },
      bindExtensions: () => session.bindExtensions({ mode: 'print' }),
      setActiveToolsByName: (names: string[]) => {
        if (names.some(name => !allowed.has(name))) throw new Error('Worker cannot widen its tool set.');
        return session.setActiveToolsByName(names);
      },
    } satisfies ProviderWorkerSession;
  };
}
