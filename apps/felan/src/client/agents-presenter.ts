import type { ExtensionContext } from '@felan-ai/agent-core';
import { type AgentViewTranscript } from '../subagents/types.js';
import { Key, matchesKey, type OverlayHandle } from '@earendil-works/pi-tui';
import { AgentNavigator, AGENT_NAVIGATOR_OVERLAY_OPTIONS, type AgentNavigatorHost } from '../subagents/agent-navigator.js';
import { ClientAgentHost } from './agent-host.js';

type Ui = Pick<ExtensionContext['ui'], 'custom' | 'onTerminalInput' | 'notify'>;
interface ActiveView { ready: Promise<void>; closed: Promise<void>; view?: AgentNavigator; finish?: () => void; overlay?: OverlayHandle }

export function createClientAgentViews(
  client: ConstructorParameters<typeof ClientAgentHost>[0], parent: string,
  ui: Ui,
  settings: () => AgentViewTranscript['settings'],
  toolPresentation?: AgentNavigatorHost['toolPresentation'],
): { host: ClientAgentHost; open(agentId?: string): Promise<void>; dispose(): Promise<void> } {
  const host = new ClientAgentHost(client, parent, settings, toolPresentation);
  const lifetime = new AbortController();
  let active: ActiveView | undefined;
  let disposing: Promise<void> | undefined;
  const open = (agentId?: string): Promise<void> => {
    if (lifetime.signal.aborted) return Promise.reject(new Error('Agent view is closed.'));
    if (active) return active.ready;
    host.reloadView();
    let ready!: () => void; let fail!: (error: unknown) => void;
    const current: ActiveView = { ready: new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; }), closed: Promise.resolve() };
    active = current;
    const off = ui.onTerminalInput(data => {
      if (!matchesKey(data, Key.escape) || !current.overlay?.isFocused()) return undefined;
      current.view?.close(); return { consume: true };
    });
    const abort = () => { off(); fail(new Error('Agent view is closed.')); current.finish?.(); };
    lifetime.signal.addEventListener('abort', abort, { once: true });
    try {
      current.closed = ui.custom<void>((tui, theme, keybindings, done) => {
        current.finish = () => done(undefined);
        if (lifetime.signal.aborted) { done(undefined); return { render: () => [], invalidate() {} }; }
        current.view = new AgentNavigator(tui, host, theme, keybindings, current.finish, agentId);
        ready();
        return current.view;
      }, { overlay: true, overlayOptions: AGENT_NAVIGATOR_OVERLAY_OPTIONS, onHandle: handle => { current.overlay = handle; } }).then(() => {
        if (!current.view) fail(new Error('Agent view was not mounted.'));
      }).catch(error => {
        fail(error); if (!lifetime.signal.aborted) ui.notify(error instanceof Error ? error.message : 'Agent view failed.', 'error');
      }).finally(() => { lifetime.signal.removeEventListener('abort', abort); off(); current.view?.dispose(); if (active === current) active = undefined; });
    } catch (error) { lifetime.signal.removeEventListener('abort', abort); off(); active = undefined; fail(error); }
    return current.ready;
  };
  return { host, open, dispose() {
    return disposing ??= (async () => {
      lifetime.abort(); active?.finish?.();
      if (active?.view) await active.closed;
      await host.dispose();
    })();
  } };
}
