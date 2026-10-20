import type { ExtensionUi } from '@felan-ai/agent-core';
import type { LocalMcpOAuthPresenter } from './oauth-host.js';

export type AuthorizationUrlOpener = (url: string, signal: AbortSignal) => Promise<void>;

export function canAuthorize(ui: ExtensionUi): boolean {
  return ui.canRequest({ title: 'Authorize MCP server', fallback: 'Authorize on this machine', input: { fields: [] },
    actions: [{ id: 'cancel', label: 'Cancel', target: 'element', outcome: 'cancel' }] }, { audience: 'host' });
}

export function createAuthorizationPresenter(ui: ExtensionUi, openUrl?: AuthorizationUrlOpener): LocalMcpOAuthPresenter {
  return async ({ server, url, signal }) => {
    const name = server.replace(/[\u0000-\u001F\u007F-\u009F]/gu, ' ').slice(0, 120);
    const opened = openUrl !== undefined && await openUrl(url, signal).then(() => true, () => false);
    const link = authorizationLink(url);
    const result = await ui.request({
      title: `Authorize ${name}`,
      description: [
        opened
          ? `Your browser was opened to authorize the ${name} MCP server.`
          : `Open the authorization page in a browser on this machine to authorize the ${name} MCP server.`,
        ...(link === undefined ? [url] : []),
        'This dialog closes automatically when authorization finishes.',
      ].join('\n\n'),
      ...(link === undefined ? {} : { markdown: link }),
      fallback: 'Complete MCP authorization on the host machine.',
      input: { fields: [] },
      actions: [{ id: 'cancel', label: 'Cancel authorization', target: 'element', outcome: 'cancel' }],
    }, { audience: 'host', signal, deferrable: false, transient: true });
    if (result.state === 'cancelled' && result.reason === 'unsupported') {
      throw new Error('MCP authorization requires an eligible local console.');
    }
  };
}

// An explicit link destination keeps the exact URL; plain text is markdown-escaped and bare autolinks drop trailing
// punctuation. UI markdown validation cannot represent brackets in link destinations, so those URLs stay plain text.
function authorizationLink(url: string): string | undefined {
  if (/[[\]]/u.test(url)) return undefined;
  return `[Open the authorization page](${url.replace(/[\\()]/gu, '\\$&')})`;
}
