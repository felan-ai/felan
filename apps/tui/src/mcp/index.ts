import type { FelanExtension } from '@felan-ai/agent-core';
import { createMcpExtension } from '@felan-ai/ext-mcp';
import { readLocalMcpConfig } from './config.js';
import { createLocalMcpOAuthHost } from './oauth-host.js';
import { HERDR_BLOCKED_EVENT } from '../herdr.js';

export function createLocalMcpExtension(): FelanExtension {
  return async (pi) => {
    const local = await readLocalMcpConfig(pi.runtime, pi.agentDir);
    const extension = createMcpExtension({
      config: local.config,
      oauthHost: createLocalMcpOAuthHost(pi.agentDir, local.oauth, {
        onAttention: (active, label) => pi.events.emit(HERDR_BLOCKED_EVENT, { active, label }),
      }),
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
