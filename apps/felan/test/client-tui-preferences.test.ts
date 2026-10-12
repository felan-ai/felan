import { afterEach, expect, it } from 'vitest';
import { SessionClient } from '../src/client/client.js';
import { DaemonConfiguration } from '../../daemon/src/daemon/configuration.js';
import { DaemonTuiPreferences } from '../../daemon/src/daemon/tui-preferences.js';
import { SessionServer } from '../../daemon/src/daemon/server.js';
import { serverFixture } from '../../daemon/test/fixtures/server.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const f = await serverFixture({ now: Date.now }); cleanup.push(() => f.dispose());
  const preferences = new DaemonTuiPreferences({ agentDir: f.owner.target.agentDir, assertCurrent: () => f.owner.assertCurrent() });
  return { ...f, preferences };
}

it('advertises explicit TUI-only preferences and commits settings through ordered admission', async () => {
  const f = await fixture(); const server = new SessionServer({ registry: f.registry, preferences: f.preferences,
    models: f.root.runtime.session.modelRuntime, version: 'fixture',
    configuration: new DaemonConfiguration({ agentDir: f.owner.target.agentDir, definitions: [], assertCurrent: () => f.owner.assertCurrent() }) });
  const clients: SessionClient[] = [];
  cleanup.push(async () => { clients.forEach(client => client.close()); server.close(); await server.settleCommands(); });
  await server.start();
  for (const kind of ['tui', 'headless'] as const) {
    const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
      kind, clientVersion: 'fixture', retries: 0 }); clients.push(client); await client.connect();
    if (kind === 'headless') {
      expect(client.capabilities?.operations).not.toContain('tui.preferences.set');
      expect(() => client.request('tui.preferences.set', { values: { hideThinking: true } })).toThrow();
    } else {
      expect(client.capabilities?.operations).toContain('tui.preferences.get');
      expect(await client.request('tui.preferences.set', { values: { hideThinking: true } })).toMatchObject({ outcome: 'accepted' });
      expect(await client.request('tui.preferences.get', {})).toMatchObject({ outcome: 'accepted', result: { hideThinking: true } });
    }
  }
  expect(f.store.snapshot().requests.filter(request => request.op === 'tui.preferences.set')).toHaveLength(1);
});
