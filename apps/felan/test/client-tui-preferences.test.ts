import { afterEach, expect, it } from 'vitest';
import { SessionClient } from '../src/client/client.js';
import { DaemonConfiguration } from '../src/providers/configuration.js';
import { SessionServer } from '../../daemon/src/daemon/server.js';
import { serverFixture } from '../../daemon/test/fixtures/server.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const f = await serverFixture({ now: Date.now }); cleanup.push(() => f.dispose());
  return f;
}

it('does not expose client display preferences to any daemon client', async () => {
  const f = await fixture(); const server = new SessionServer({ registry: f.registry,
    models: f.root.runtime.session.modelRuntime, version: 'fixture',
    configuration: new DaemonConfiguration({ agentDir: f.owner.target.agentDir, definitions: [], assertCurrent: () => f.owner.assertCurrent() }) });
  const clients: SessionClient[] = [];
  cleanup.push(async () => { clients.forEach(client => client.close()); server.close(); await server.settleCommands(); });
  await server.start();
  for (const kind of ['tui', 'acp', 'headless'] as const) {
    const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
      kind, clientVersion: 'fixture', retries: 0 }); clients.push(client); await client.connect();
    expect(client.capabilities?.operations).not.toEqual(expect.arrayContaining(['tui.preferences.get', 'tui.preferences.set']));
  }
  expect(f.store.snapshot().requests).toHaveLength(0);
});
