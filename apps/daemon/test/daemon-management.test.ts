import { afterEach, expect, it, vi } from 'vitest';
import { SessionClient } from '../../felan/src/client/client.js';
import { TestHostConfiguration as DaemonConfiguration } from './fixtures/host-services.js';
import { HostLifecycle } from '../src/daemon/lifecycle.js';
import { SessionServer } from '../src/daemon/server.js';
import { gate, serverFixture } from './fixtures/server.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function fixture(held = false) {
  const f = await serverFixture({ now: Date.now }); const settled = gate(); const complete = vi.fn(async () => {});
  const lifecycle = new HostLifecycle({ target: f.owner.target, identity: f.owner.identity,
    beginDrain: () => f.registry.beginDrain(), settle: async () => { if (held) await settled.promise; }, complete });
  const server = new SessionServer({ registry: f.registry, models: f.root.runtime.session.modelRuntime, version: 'fixture',
    configuration: new DaemonConfiguration({ definitions: [], assertCurrent: () => f.owner.assertCurrent() }),
    management: { lifecycle, logs: () => ({ entries: [{ timestamp: 1, level: 'info', message: 'Daemon ready.' }] }) } });
  const clients: SessionClient[] = [];
  cleanup.push(async () => { settled.resolve(); for (const client of clients) client.close(); server.close(); await f.dispose(); });
  await server.start();
  async function client(kind: 'tui' | 'acp' | 'headless' = 'tui') {
    const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
      clientVersion: 'fixture', kind, expected: f.owner.identity });
    clients.push(client); await client.connect(); return client;
  }
  return { ...f, client, lifecycle, complete, settled };
}

it('advertises management operations to every verified local client and exposes bounded log data', async () => {
  const f = await fixture();
  for (const kind of ['tui', 'acp', 'headless'] as const) {
    const client = await f.client(kind);
    expect(client.capabilities?.operations).toEqual(expect.arrayContaining(['host.stop', 'host.restart', 'host.logs']));
    expect(await client.request('host.logs', { limit: 5 })).toMatchObject({ outcome: 'accepted', result: { entries: [{ message: 'Daemon ready.' }] } });
  }
});

it('uses the identity-verified control connection for consented restart', async () => {
  const f = await fixture(true); const client = await f.client();
  await expect(client.control('host.restart')).rejects.toThrow(); expect(f.lifecycle.state).toBe('ready');
  const result = await client.control('host.restart', 'drain');
  expect(result).toMatchObject({ outcome: 'accepted', state: 'draining', identity: f.owner.identity });
  expect(await client.control('host.status')).toMatchObject({ outcome: 'accepted', state: 'draining' });
  expect(f.complete).not.toHaveBeenCalled(); f.settled.resolve();
  await vi.waitFor(() => expect(f.complete).toHaveBeenCalledWith('restart'));
});

it('rejects new session work during drain while keeping status available', async () => {
  const f = await fixture(true); const client = await f.client(); await client.attach(f.root.sessionId);
  expect(await client.request('host.stop', { expected: f.owner.identity, mode: 'drain' })).toMatchObject({ outcome: 'accepted', result: { state: 'draining' } });
  expect(await client.request('prompt', { text: 'must not run' }, { session: f.root.sessionId })).toMatchObject({ outcome: 'rejected', error: { code: 'busy' } });
  expect(await client.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { state: 'draining' } });
  expect(f.root.runtime.session.messages).toHaveLength(0);
  await expect(client.attach(f.root.sessionId)).rejects.toThrow();
});

it('keeps a mismatched daemon running for a client that cannot relaunch it', async () => {
  const f = await fixture(true);
  const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
    clientVersion: 'fixture', expectedDaemonVersion: 'different-version', kind: 'tui' });
  cleanup.push(async () => client.close());
  await expect(client.connect()).rejects.toThrow('version differs');
  expect(client.status).toBe('incompatible'); expect(client.identity).toEqual(f.owner.identity); expect(client.incompatibleActiveWork).toBe(0);
  expect(f.lifecycle.state).toBe('ready');
  expect(await client.control('host.status')).toMatchObject({ outcome: 'accepted', state: 'ready' });
  await expect(client.control('host.restart')).rejects.toThrow(); expect(f.lifecycle.state).toBe('ready');
  expect(await client.control('host.restart', 'drain')).toMatchObject({ outcome: 'accepted' });
});
