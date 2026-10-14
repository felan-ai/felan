import { HostAgentRuntime } from '@felan-ai/agent-core';
import { createTestSessionLifecycle as createKernelLifecycle } from '../../../../daemon/test/fixtures/session-runtime.js';
import { createLocalSessionRuntime } from '../../../src/providers/session-runtime.js';
import { builtinExtensionPackages } from '../../../src/providers/extension-catalog.js';

export function createTestLocalSessionLifecycle(options: Parameters<typeof createKernelLifecycle>[0] & {
  initializeProcess?: Parameters<typeof createLocalSessionRuntime>[0]['initializeProcess'];
}) {
  const { initializeProcess, ...kernelOptions } = options;
  return createKernelLifecycle({ ...kernelOptions,
    composition: options.composition ?? createLocalSessionRuntime({ initializeProcess: initializeProcess ?? (async () => ({ diagnostics: [], assertConfiguration: () => [] })), runtimeService: { create: (cwd, settings) => new HostAgentRuntime(cwd, settings) },
      ...(options.runtimeFactory ? { runtimeFactory: options.runtimeFactory } : {}) }),
    extensionAllowlist: options.extensionAllowlist ?? Object.values(builtinExtensionPackages),
  });
}
