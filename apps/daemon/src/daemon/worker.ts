import type { HostWorkerLauncher, ModelReference, ModelRuntime, SessionRef } from '@felan-ai/agent-core';
import type { ProviderWorkerLauncher, ProviderWorkerSession } from './provider.js';
import type { SessionRegistry } from './registry.js';
import type { SessionResources, SessionWorkerConfiguration } from './session-lifecycle-contracts.js';
import type { DaemonOwnership } from './ownership.js';
import { pathInside } from './target.js';

export function assertStagedWorker(owner: DaemonOwnership, resources: SessionResources, worker: SessionWorkerConfiguration,
  identityExists: (id: string) => boolean): { id: string; path: string } {
  const id = worker.sessionManager.getSessionId(); const file = worker.sessionManager.getSessionFile();
  if (!id || id === '.' || id === '..' || id.includes('\0') || !file || identityExists(id)) {
    throw Object.assign(new Error('Worker transcript must have a fresh identity.'), { code: 'invalid_request' });
  }
  const path = owner.assertOwnsPath(file);
  if (!pathInside(resources.sessionDir, path)) {
    throw Object.assign(new Error('Worker transcript is outside the host session directory.'), { code: 'forbidden' });
  }
  const workspace = owner.assertOwnsPath(worker.runtime.cwd);
  if (!(resources.workerRoots ?? []).some(root => pathInside(root, workspace))) {
    throw Object.assign(new Error('Worker workspace is outside managed staging storage.'), { code: 'forbidden' });
  }
  const tools = new Set(['read', 'ls', 'grep', 'edit', 'write', ...(worker.customTools ?? []).map(tool => tool.name)]);
  if (!worker.allowedTools.length || worker.allowedTools.some(name => !tools.has(name) || name === 'bash')) {
    throw Object.assign(new Error('Worker tools exceed the staged-artifact policy.'), { code: 'forbidden' });
  }
  return { id, path };
}

export async function resolveWorkerConfiguration(request: Parameters<ProviderWorkerLauncher>[0], modelRuntime: ModelRuntime,
  allowedModels?: readonly ModelReference[]): Promise<SessionWorkerConfiguration> {
  if (!request || !request.model || !request.runtime || !request.sessionManager || !request.settingsManager || !Array.isArray(request.allowedTools)) throw new Error('Worker request is invalid.');
  request.signal?.throwIfAborted();
  const selected = { provider: request.model.provider, id: request.model.id };
  const allowedTools = [...request.allowedTools];
  if (allowedModels && !allowedModels.some(model => model.provider === selected.provider && model.id === selected.id)) throw new Error('Worker model is outside the current scope.');
  const available = await modelRuntime.getAvailable(selected.provider, request.signal ? { signal: request.signal } : {});
  request.signal?.throwIfAborted();
  const model = available.find(value => value.id === selected.id && value.provider === selected.provider);
  if (!model) throw new Error('Worker model is unavailable.');
  return { ...request, allowedTools, model, modelRuntime };
}

export function createRegisteredWorkerLauncher(registry: SessionRegistry, current: SessionRef, modelRuntime: ModelRuntime,
  allowedModels?: readonly ModelReference[]): ProviderWorkerLauncher {
  return async request => {
    registry.assertNewWork(); registry.assertDispatch(current.id);
    const worker = await resolveWorkerConfiguration(request, modelRuntime, allowedModels);
    const allowedTools = worker.allowedTools;
    registry.assertNewWork(); registry.assertDispatch(current.id);
    const binding = await registry.openWorker(current.id, worker);
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

export function createHostWorkerLauncher(registry: SessionRegistry, modelRuntime: ModelRuntime,
  allowedModels?: (signal?: AbortSignal) => Promise<readonly ModelReference[] | undefined>): HostWorkerLauncher {
  return async request => {
    const lifetime = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, registry.hostWorkSignal(), ...(request.signal ? [request.signal] : [])]);
    let worker: SessionWorkerConfiguration;
    let binding: Awaited<ReturnType<SessionRegistry['openHostWorker']>>;
    try {
      const scope = await allowedModels?.(signal);
      signal.throwIfAborted();
      worker = await resolveWorkerConfiguration({ ...request, signal }, modelRuntime, scope);
      binding = await registry.openHostWorker(worker);
    } catch (error) { signal.throwIfAborted(); throw error; }
    if (signal.aborted) { await registry.closeHostWorker(binding.sessionId); signal.throwIfAborted(); }
    const session = binding.runtime.session; const allowed = new Set(worker.allowedTools);
    return {
      dispose: () => { lifetime.abort(); return registry.closeHostWorker(binding.sessionId); }, abort: () => session.abort(),
      subscribe: listener => session.subscribe(listener),
      get messages() { return session.messages; }, get thinkingLevel() { return session.thinkingLevel; },
      getActiveToolNames: () => session.getActiveToolNames(),
      prompt: async (...args) => {
        signal.throwIfAborted();
        // Pi ignores abort() until its run starts after authentication; a listener error at agent_start fails the run before inference.
        const unsubscribe = session.subscribe(event => {
          if (event.type === 'agent_start') signal.throwIfAborted();
          if (event.type === 'compaction_start' && signal.aborted) session.abortCompaction();
        });
        try { return await registry.runWorker(binding.sessionId, () => session.prompt(...args)); }
        finally { unsubscribe(); signal.throwIfAborted(); }
      },
      bindExtensions: () => session.bindExtensions({ mode: 'print' }),
      setActiveToolsByName: names => {
        if (names.some(name => !allowed.has(name))) throw new Error('Worker cannot widen its tool set.');
        return session.setActiveToolsByName(names);
      },
    };
  };
}
