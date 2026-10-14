import type { RuntimeDependenciesService } from '@felan-ai/agent-core';
import type { InteractionBroker } from './broker.js';
import type { HostSetup } from './host-services.js';

export function createRuntimeDependenciesPort(setup: Pick<HostSetup, 'dependency' | 'installApprovedDependency'>,
  broker: Pick<InteractionBroker, 'canPresent' | 'request'>): RuntimeDependenciesService {
  return Object.freeze<RuntimeDependenciesService>({
    async install(request, options) {
      const signal = options?.signal;
      if (signal?.aborted) return { status: 'cancelled', message: 'Dependency installation was cancelled.' };
      if (!request || typeof request.id !== 'string' || request.id.length > 128) return { status: 'unavailable', message: 'Unknown runtime dependency.' };
      const id = request.id;
      try {
        const dependency = setup.dependency(id);
        if (!dependency) return { status: 'unavailable', message: 'Dependency installation is unavailable.' };
        const question = { kind: 'dependency' as const, dependency: id, message: `${dependency.label}: ${dependency.description}` };
        const scope = { kind: 'host' as const };
        if (!broker.canPresent(question, scope)) return { status: 'unavailable', message: 'Dependency installation requires a local console.' };
        const answer = await broker.request(question, scope, signal ? { signal } : {});
        if (answer.state !== 'answered' || answer.answer.kind !== 'dependency' || !answer.answer.approved || signal?.aborted) {
          return { status: 'cancelled', message: 'Dependency installation was not approved.' };
        }
        return await setup.installApprovedDependency(id, signal);
      } catch {
        return signal?.aborted ? { status: 'cancelled', message: 'Dependency installation was cancelled.' }
          : { status: 'unavailable', message: 'Dependency installation is unavailable.' };
      }
    },
  });
}
