import { HOST_RUNTIME_SERVICE, HostAgentRuntime } from '@felan-ai/agent-core';
import { defineServiceProvider } from '../../src/daemon/provider.js';
import { SESSION_RUNTIME_SERVICE } from '../../src/daemon/session-runtime.js';
import { createTestSessionRuntime } from './session-runtime.js';

export default defineServiceProvider({
  provides: [HOST_RUNTIME_SERVICE, SESSION_RUNTIME_SERVICE],
  async create() {
    return {
      implementations: [
        { contract: HOST_RUNTIME_SERVICE, value: { create: (cwd: string, options: ConstructorParameters<typeof HostAgentRuntime>[1]) => new HostAgentRuntime(cwd, options) } },
        { contract: SESSION_RUNTIME_SERVICE, value: createTestSessionRuntime() },
      ],
      async dispose() {},
    };
  },
});
