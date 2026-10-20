import { defineServiceProvider } from '@felan-ai/daemon/provider';
import { FELAN_PLATFORM_SERVICE } from '@felan-ai/agent-core';
import { createLocalPlatformService } from './platform.js';

export default defineServiceProvider({
  provides: [FELAN_PLATFORM_SERVICE],
  async create() {
    const platform = createLocalPlatformService();
    return { implementations: platform ? [{ contract: FELAN_PLATFORM_SERVICE, value: platform }] : [], async dispose() {} };
  },
});
