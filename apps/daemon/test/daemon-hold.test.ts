import { afterEach, expect, it, vi } from 'vitest';
import { SessionClient } from '../../felan/src/client/client.js';
import { TestHostConfiguration as DaemonConfiguration } from './fixtures/host-services.js';
import { createRegistryInteractionBroker } from '../src/daemon/broker.js';
import { HostLifecycle } from '../src/daemon/lifecycle.js';
import { SessionServer } from '../src/daemon/server.js';
import { settleDaemonWork } from '../src/daemon/service.js';
import { gate, serverFixture } from './fixtures/server.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

/** Wires the lifecycle the way `startDaemonService` does, with a connector stub that records when claims stop and resume. */
async function fixture(options: { holdTimeoutMs?: number; providersBusy?: () => boolean } = {}) {
  const turn = gate(); const release = gate();
  const f = await serverFixture({ now: Date.now, extension: pi => { pi.on('agent_end', async () => { turn.resolve(); await release.promise; }); } });
  const broker = createRegistryInteractionBroker(f.registry);
  const connector = { claiming: true, beginDrain: vi.fn(() => { connector.claiming = false; }), endDrain: vi.fn(() => { connector.claiming = true; }) };
  const complete = vi.fn(async () => {});
  let server!: SessionServer;
  const lifecycle = new HostLifecycle({ target: f.owner.target, identity: f.owner.identity,
    ...(options.holdTimeoutMs ? { holdTimeoutMs: options.holdTimeoutMs } : {}),
    beginDrain: () => { connector.beginDrain(); f.registry.beginDrain(); },
    endDrain: () => { f.registry.endDrain(); connector.endDrain(); },
    holdAdmission: () => { connector.beginDrain(); f.registry.holdAdmission(); },
    activity: () => server.activity(),
    settle: (mode, signal) => settleDaemonWork(f.registry, broker, mode, signal), complete });
  server = new SessionServer({ registry: f.registry, models: f.root.runtime.session.modelRuntime, version: 'fixture', broker,
    ...(options.providersBusy ? { providersBusy: options.providersBusy } : {}),
    configuration: new DaemonConfiguration({ definitions: [], assertCurrent: () => f.owner.assertCurrent() }),
    management: { lifecycle, logs: () => ({ entries: [] }) } });
  const clients: SessionClient[] = [];
  cleanup.push(async () => { turn.resolve(); release.resolve(); for (const client of clients) client.close(); server.close(); await f.dispose(); });
  await server.start();
  async function client() {
    const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
      clientVersion: 'fixture', kind: 'tui', expected: f.owner.identity });
    clients.push(client); await client.connect(); return client;
  }
  return { ...f, client, lifecycle, server, connector, complete, turn, release };
}

it('holds an idle daemon: closes admission and remote claims in one step and reports the hold next to state', async () => {
  const f = await fixture(); const client = await f.client();
  expect(await client.control('host.status')).toMatchObject({ state: 'ready', stopModes: ['drain', 'force', 'hold'] });
  expect(await client.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { stopModes: ['drain', 'force', 'hold'] } });
  const order: string[] = [];
  f.connector.beginDrain.mockImplementation(() => { order.push('claims-stopped'); f.connector.claiming = false; });
  const activity = f.server.activity.bind(f.server);
  vi.spyOn(f.server, 'activity').mockImplementation(async () => {
    order.push('activity');
    // New work arriving during the idle check is already refused.
    expect(() => f.registry.create({ cwd: f.cwd, target: { kind: 'new' } })).toThrow('draining');
    return activity();
  });
  const response = await client.control('host.restart', 'hold');
  expect(order.slice(0, 2)).toEqual(['claims-stopped', 'activity']);
  expect(response).toMatchObject({ outcome: 'accepted', state: 'draining', held: { action: 'restart' } });
  const held = response.held!;
  expect(held.until - held.since).toBe(60_000);
  expect(f.lifecycle.held).toEqual(held);
  expect(await client.control('host.status')).toMatchObject({ outcome: 'accepted', state: 'draining', held });
  expect(await client.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { state: 'draining', held, active: { runs: 0, work: 0 } } });
  expect(f.connector.claiming).toBe(false);
  expect(f.server.admissionClosed()).toBe(true);
  expect(await client.request('sessions.create', { cwd: f.cwd })).toMatchObject({ outcome: 'rejected', error: { code: 'busy' } });
  expect(f.complete).not.toHaveBeenCalled();
});

it('accepts the same hold again and refuses a hold for the other action', async () => {
  const f = await fixture(); const client = await f.client();
  const first = await client.control('host.stop', 'hold');
  expect(await client.control('host.stop', 'hold')).toMatchObject({ outcome: 'accepted', held: first.held });
  expect(await client.control('host.restart', 'hold')).toMatchObject({ outcome: 'rejected', error: { code: 'busy' }, held: first.held });
});

it('rejects a hold as busy while a run is active and leaves admission open', async () => {
  const f = await fixture(); const client = await f.client();
  const running = f.root.runtime.session.prompt('existing'); await f.turn.promise;
  const response = await client.control('host.restart', 'hold');
  expect(response).toMatchObject({ outcome: 'rejected', state: 'ready', error: { code: 'busy' } });
  expect(response.held).toBeUndefined();
  expect(f.lifecycle.state).toBe('ready'); expect(f.lifecycle.held).toBeUndefined();
  expect(f.connector.claiming).toBe(true); expect(f.server.admissionClosed()).toBe(false);
  expect(await client.request('sessions.create', { cwd: f.cwd })).toMatchObject({ outcome: 'accepted' });
  expect(f.root.runtime.session.isIdle).toBe(false);
  f.release.resolve(); await running;
});

it.each([
  ['a promoted shell command', { processes: 1 }],
  ['a busy provider', { providers: 1 }],
] as const)('rejects a hold as busy while %s is interruptible work', async (_label, kind) => {
  let providerBusy = 'providers' in kind;
  const f = await fixture({ providersBusy: () => providerBusy });
  if ('processes' in kind) vi.spyOn(f.registry.processes, 'interruptibleCount').mockResolvedValue(kind.processes);
  const client = await f.client();
  expect(await client.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { active: { runs: 0, work: 1,
    workByKind: { sessions: 0, processes: 0, interactions: 0, providers: 0, ...kind } } } });
  expect(await client.request('host.restart', { expected: f.owner.identity, mode: 'hold' })).toMatchObject({ outcome: 'rejected', error: { code: 'busy' } });
  expect(f.lifecycle.state).toBe('ready'); expect(f.connector.claiming).toBe(true);
  expect(await client.request('sessions.create', { cwd: f.cwd })).toMatchObject({ outcome: 'accepted' });
  providerBusy = false;
});

it('reports the work count by kind in host.status', async () => {
  const f = await fixture({ providersBusy: () => true });
  vi.spyOn(f.registry.processes, 'interruptibleCount').mockResolvedValue(2);
  const client = await f.client();
  const running = f.root.runtime.session.prompt('existing'); await f.turn.promise;
  expect(await client.request('host.status', {})).toMatchObject({ outcome: 'accepted', result: { active: {
    work: 4, workByKind: { sessions: 1, processes: 2, interactions: 0, providers: 1 } } } });
  f.release.resolve(); await running;
});

it.each(['drain', 'force'] as const)('exits promptly when a %s stop arrives while held', async mode => {
  const f = await fixture(); const client = await f.client();
  expect(await client.control('host.restart', 'hold')).toMatchObject({ outcome: 'accepted' });
  const started = performance.now();
  expect(await client.control('host.stop', mode)).toMatchObject({ outcome: 'accepted', state: 'draining' });
  expect(f.lifecycle.held).toBeUndefined();
  await vi.waitFor(() => expect(f.complete).toHaveBeenCalledExactlyOnceWith('stop'), { timeout: 5_000 });
  expect(performance.now() - started).toBeLessThan(5_000);
  await vi.waitFor(() => expect(f.lifecycle.state).toBe('stopped'));
});

it('reopens admission and claims again when no stop arrives before the hold expires', async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const response = await f.server.requestManagement({ v: 1, id: requestIdNow(), op: 'host.restart', params: { expected: f.owner.identity, mode: 'hold' } });
  expect(response).toMatchObject({ outcome: 'accepted', result: { state: 'draining', held: { action: 'restart' } } });
  expect(f.connector.claiming).toBe(false);
  await vi.advanceTimersByTimeAsync(59_000);
  expect(f.lifecycle.state).toBe('draining'); expect(f.connector.endDrain).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.lifecycle.state).toBe('ready'); expect(f.lifecycle.held).toBeUndefined();
  expect(f.connector.endDrain).toHaveBeenCalledOnce(); expect(f.connector.claiming).toBe(true);
  expect(f.server.admissionClosed()).toBe(false);
  vi.useRealTimers();
  await expect(f.registry.create({ cwd: f.cwd, target: { kind: 'new' } })).resolves.toMatchObject({ sessionId: expect.any(String) });
  expect(f.complete).not.toHaveBeenCalled();
});

it('cancels the hold deadline once a stop replaces the hold', async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  await f.server.requestManagement({ v: 1, id: requestIdNow(), op: 'host.restart', params: { expected: f.owner.identity, mode: 'hold' } });
  await f.server.requestManagement({ v: 1, id: requestIdNow(), op: 'host.restart', params: { expected: f.owner.identity, mode: 'drain' } });
  await vi.advanceTimersByTimeAsync(61_000);
  expect(f.connector.endDrain).not.toHaveBeenCalled();
  vi.useRealTimers();
  await vi.waitFor(() => expect(f.complete).toHaveBeenCalledExactlyOnceWith('restart'));
});

function requestIdNow(): string {
  const time = Date.now().toString(16).padStart(12, '0');
  const random = crypto.randomUUID();
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(15, 18)}-8${random.slice(20, 23)}-${random.slice(-12)}`;
}

it('reopens admission when activity cannot be counted within the idle-check deadline', async () => {
  const f = await fixture();
  vi.spyOn(f.server, 'activity').mockImplementationOnce(() => new Promise(() => {}));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const response = f.server.requestManagement({ v: 1, id: requestIdNow(), op: 'host.restart', params: { expected: f.owner.identity, mode: 'hold' } });
  await vi.advanceTimersByTimeAsync(9_000);
  expect(f.server.admissionClosed()).toBe(true);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await response).toMatchObject({ outcome: 'rejected', error: { code: 'unavailable' } });
  expect(f.lifecycle.state).toBe('ready'); expect(f.connector.claiming).toBe(true);
});
