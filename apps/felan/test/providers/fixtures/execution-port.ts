import { createFelanServiceRegistry } from '@felan-ai/agent-core';
import type { InteractionBroker } from '../../../../daemon/src/daemon/broker.js';
import { createDaemonExecutionServices } from '../../../../daemon/src/daemon/execution-services.js';
import type { SessionRegistry } from '../../../../daemon/src/daemon/registry.js';
import type { SessionExecutionPort } from '../../../../daemon/src/daemon/session-execution.js';
import { createTestSessionRuntime } from '../../../../daemon/test/fixtures/session-runtime.js';

export async function executionPort(registry: SessionRegistry, id: string): Promise<SessionExecutionPort> {
  const binding = registry.binding(id);
  if (!binding) throw new Error('Fixture session must be registered');
  const composition = createTestSessionRuntime();
  const broker = { request: async () => ({ state: 'cancelled', reason: 'unsupported' }), canPresent: () => false,
    subscribeClients: () => () => {}, approvalExtension: () => ({ name: 'fixture-approval', factory() {} }),
  } as unknown as InteractionBroker;
  const services = createDaemonExecutionServices(registry, broker, composition)({ request: { cwd: binding.resources.cwd,
    target: { kind: 'new' }, ...(binding.parentSessionId ? { parentSessionId: binding.parentSessionId } : {}) },
    getExecutionPolicy: () => registry.getPolicy(id),
  });
  const port = services.extensions.executionPort!({ runtime: binding.agentRuntime, modelRuntime: binding.runtime.session.modelRuntime,
    settingsManager: binding.runtime.session.settingsManager, sessionManager: binding.runtime.session.sessionManager,
    resources: binding.resources, rootSessionId: binding.rootSessionId, policy: registry.getPolicy(id), extensionPackages: [],
    extensionConfigs: new Map(), extensionConfigOverrides: [], scopedModels: [], skillPaths: [],
    classifier: binding.agentRuntime.classifier, dynamicThinking: false, services: createFelanServiceRegistry(),
    importExtension: async () => ({ default() {} }),
  });
  if (!port) throw new Error('Scoped execution port was not supplied');
  return port;
}

export async function registeredExecutionHost(registry: SessionRegistry, id: string, options: { settings?: import('@felan-ai/daemon/provider').ExecutionSettings; cwd?: string; agentDir?: string; modelRuntime?: unknown }) {
  const host = registry.executionHost(id);
  host.configure(options.settings ?? {});
  return host;
}
