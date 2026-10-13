import {
  HostAgentRuntime,
  MODELS_SERVICE,
  SessionManager,
  createAgentCoreSession,
  createFelanServiceRegistry,
  type ModelRuntime,
} from '@felan-ai/agent-core';
import { createLocalSessionRuntime } from '../../src/providers/session-runtime.js';
import { createLocalModelsService } from '../../src/providers/models.js';

type PrepareRequest = Parameters<ReturnType<typeof createLocalSessionRuntime>['prepare']>[0];

export async function composeLocalSession(options: {
  cwd: string;
  agentDir: string;
  homeDir?: string;
  modelRuntime?: ModelRuntime;
  runtimeFactory?: Parameters<typeof createLocalSessionRuntime>[0]['runtimeFactory'];
  sessionManager?: SessionManager;
  extensionPackages?: readonly string[];
  extensionPaths?: readonly string[];
  model?: PrepareRequest['model'];
  thinkingLevel?: PrepareRequest['thinkingLevel'];
}) {
  const provider = createLocalSessionRuntime({
    runtimeService: { create: (cwd, settings) => new HostAgentRuntime(cwd, settings) },
    initializeProcess: async () => ({ diagnostics: [], assertConfiguration: () => [] }),
    ...(options.runtimeFactory ? { runtimeFactory: options.runtimeFactory } : {}),
  });
  const environment = await provider.resolveEnvironment(options);
  const sessionManager = options.sessionManager ?? SessionManager.create(environment.cwd, environment.sessionDir);
  const modelRuntime = options.modelRuntime ?? await provider.createModelRuntime(options.agentDir);
  const composition = await provider.prepare({
    environment, session: { id: sessionManager.getSessionId(), root: sessionManager.getSessionId() }, modelRuntime,
    source: 'headless', extensionPackages: options.extensionPackages ?? [], extensionConfigOverrides: [],
    extensionPaths: options.extensionPaths ?? [],
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
  });
  const services = createFelanServiceRegistry();
  services.set(MODELS_SERVICE, createLocalModelsService({ modelRuntime, sessionId: sessionManager.getSessionId() }));
  try {
    const result = await createAgentCoreSession({ ...composition.options, agentDir: options.agentDir, sessionManager, services });
    return { ...result, composition, async dispose() {
      await result.session.dispose();
      services.revoke();
      await composition.dispose();
    } };
  } catch (error) {
    services.revoke();
    await composition.dispose();
    throw error;
  }
}
