import type { ExtensionUi } from '@felan-ai/agent-core';
import type { LocalMcpOAuthPresenter } from './oauth-host.js';

export function canAuthorize(ui: ExtensionUi): boolean {
  return ui.canRequest({ title: 'Authorize MCP server', fallback: 'Authorize on this machine', input: { fields: [] },
    actions: [{ id: 'cancel', label: 'Cancel', target: 'element', outcome: 'cancel' }] }, { audience: 'host' });
}

export function createAuthorizationPresenter(ui: ExtensionUi): LocalMcpOAuthPresenter {
  return async ({ server, url, signal }) => {
    const name = server.replace(/[\u0000-\u001F\u007F-\u009F]/gu, ' ').slice(0, 120);
    const result = await ui.request({
      title: 'Authorize MCP server',
      description: `Open this URL on this machine to authorize ${name}:\n\n${url}\n\nThis dialog closes when authorization finishes.`,
      fallback: 'Complete MCP authorization on the host machine.',
      input: { fields: [] },
      actions: [{ id: 'cancel', label: 'Cancel authorization', target: 'element', outcome: 'cancel' }],
    }, { audience: 'host', signal, deferrable: false, transient: true });
    if (result.state === 'cancelled' && result.reason === 'unsupported') {
      throw new Error('MCP authorization requires an eligible local console.');
    }
  };
}
