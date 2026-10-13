import { HOST_RUNTIME_SERVICE, HostAgentRuntime, type HostAgentRuntimeOptions } from '@felan-ai/agent-core';
import { defineServiceProvider } from '@felan-ai/daemon/provider';
import { FELAN_VERSION } from '../version.js';

export default defineServiceProvider({
  provides: [HOST_RUNTIME_SERVICE],
  async create() {
    return {
      implementations: [{ contract: HOST_RUNTIME_SERVICE, value: {
        create: (cwd: string, options: HostAgentRuntimeOptions) => new HostAgentRuntime(cwd, { ...options, host: { name: 'Felan', version: FELAN_VERSION } }),
      } }],
      async dispose() {},
    };
  },
});
