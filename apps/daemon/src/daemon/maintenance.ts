import type { HostMaintenance, ModelRuntime } from '@felan-ai/agent-core';
import { resolveModelScopeWithDiagnostics } from '@earendil-works/pi-coding-agent';
import { createHostWorkerLauncher } from './worker.js';
import type { HostConfiguration } from './host-services.js';
import type { SessionRegistry } from './registry.js';
import { createHostSessionsHistory } from './session-services.js';

export function createHostMaintenance() {
  let bound: { registry: SessionRegistry; service: HostMaintenance } | undefined;
  const lifetime = new AbortController();
  function current(): HostMaintenance {
    lifetime.signal.throwIfAborted();
    if (!bound) throw new Error('Host maintenance is unavailable.');
    bound.registry.assertHostWork();
    return bound.service;
  }
  const service = Object.freeze({
    get agentDir() { return current().agentDir; },
    get modelRuntime() { return current().modelRuntime; },
    get signal() { return lifetime.signal; },
    allowedModels: async signal => current().allowedModels(signal),
    sessions: selector => current().sessions(selector),
    openWorker: request => current().openWorker({ ...request,
      signal: request.signal ? AbortSignal.any([lifetime.signal, request.signal]) : lifetime.signal }),
  } satisfies HostMaintenance);
  return Object.freeze({
    service,
    bind(options: { registry: SessionRegistry; agentDir: string; modelRuntime: ModelRuntime; configuration: HostConfiguration }) {
      if (bound || lifetime.signal.aborted) throw new Error('Host maintenance cannot be rebound.');
      const { registry, agentDir, modelRuntime, configuration } = options;
      const allowedModels: HostMaintenance['allowedModels'] = async inputSignal => {
        current();
        const signal = inputSignal ? AbortSignal.any([lifetime.signal, inputSignal]) : lifetime.signal;
        signal.throwIfAborted();
        const patterns = (await configuration.get('global')).values.scopedModels;
        signal.throwIfAborted();
        if (!patterns?.length) return undefined;
        const scope = await resolveModelScopeWithDiagnostics(patterns, modelRuntime, { signal });
        signal.throwIfAborted();
        return scope.scopedModels.map(({ model }) => ({ provider: model.provider, id: model.id }));
      };
      bound = { registry, service: { agentDir, modelRuntime, signal: lifetime.signal, allowedModels,
        sessions: selector => createHostSessionsHistory(registry, selector, () => { current(); }),
        openWorker: createHostWorkerLauncher(registry, modelRuntime, allowedModels) } };
    },
    close() { lifetime.abort(); },
  });
}
