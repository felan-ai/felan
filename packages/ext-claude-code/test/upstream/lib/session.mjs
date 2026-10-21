import { join } from 'node:path';
import { createAgentCoreSession, HostAgentRuntime, ModelRuntime } from '@felan-ai/agent-core';

export async function createTestSession({ cwd, agentDir, extensionFactories, sessionManager, settingsManager, model }) {
  const result = await createAgentCoreSession({
    runtime: new HostAgentRuntime(cwd, {
      agentStorageRoot: join(agentDir, 'storage'),
      sessionStorageRoot: join(agentDir, 'sessions', sessionManager.getSessionId()),
      agentDir,
    }),
    agentDir,
    sessionManager,
    settingsManager,
    model,
    modelRuntime: await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null }),
    extensionPackages: [],
    importExtension: async () => { throw new Error('Unexpected package import'); },
    inlineExtensions: extensionFactories.map((factory, index) => ({ name: `test-extension-${index}`, factory })),
  });
  if (result.extensionsResult.errors.length > 0) throw new Error(JSON.stringify(result.extensionsResult.errors));
  return result;
}
