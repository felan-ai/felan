import type { FelanExtension } from '@felan-ai/agent-core';
import { createMcpExtension } from '@felan-ai/ext-mcp';
import { readLocalMcpConfig } from './config.js';
import { createLocalMcpOAuthHost } from './oauth-host.js';

export function createLocalMcpExtension(): FelanExtension {
  return async (pi) => {
    const local = await readLocalMcpConfig(pi.runtime, pi.agentDir);
    const extension = createMcpExtension({
      config: local.config,
      oauthHost: createLocalMcpOAuthHost(pi.agentDir, local.oauth),
    });
    await extension(pi);
    if (local.warnings.length > 0) {
      pi.on('session_start', (_event, ctx) => {
        if (!ctx.hasUI) return;
        for (const warning of local.warnings) ctx.ui.notify(warning, 'warning');
      });
    }
  };
}
