import { createTestSessionLifecycle as createKernelLifecycle, createTestSessionRuntime } from '../../../daemon/test/fixtures/session-runtime.js';
import type { DaemonProcessConfiguration } from '../../src/providers/process-bootstrap.js';

export function createTestSessionLifecycle(options: Parameters<typeof createKernelLifecycle>[0] & {
  initializeProcess?: (agentDir: string) => Promise<DaemonProcessConfiguration>;
}) {
  const { initializeProcess, ...kernelOptions } = options;
  const composition = options.composition ?? createTestSessionRuntime({
    ...(options.runtimeFactory ? { runtimeFactory: options.runtimeFactory } : {}),
    ...(options.definitions ? { definitions: options.definitions } : {}),
    ...(options.skillPaths ? { skillPaths: options.skillPaths } : {}),
  });
  return createKernelLifecycle({ ...kernelOptions, composition: initializeProcess ? {
    ...composition,
    async prepare(request) {
      const state = await initializeProcess(request.environment.agentDir);
      const result = await composition.prepare(request);
      return { ...result, diagnostics: [...state.diagnostics, ...result.diagnostics,
        ...state.assertConfiguration(result.options.settingsManager.getGlobalSettings())] };
    },
  } : composition });
}
