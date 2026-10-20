import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonLineDecoder, encodeFrame, parsePublishedEvent, parsePublishedSession, type HostRegistration, type PublishedEvent, type PublishedSession, type RemoteCommandOutcome, type TextStreamEvent } from '@felan-ai/session-protocol';
import { RemoteConnector, type ConnectorPlatform, type ConnectorTokenSource, type RemoteConnectorOptions } from '../src/remote/connector.js';
import { HostTokenExchangeError, type HostTokenInfo } from '../src/remote/token.js';
import { PlatformError, parsePlatformError, type ClaimedCommand } from '../src/remote/platform.js';
import type { RemoteClock, TimerHandle } from '../src/remote/backoff.js';
import { connectLocalIpc } from '../src/daemon/ipc.js';
import { protocolTarget } from '../src/daemon/target.js';
import { SessionServer } from '../src/daemon/server.js';
import { TestHostConfiguration } from './fixtures/host-services.js';
import { serverFixture, requestId, now } from './fixtures/server.js';
import { offlineModel } from './fixtures/registry.js';
import { RemoteStorageError } from '../src/remote/state.js';
import { RemoteOutbox, RemoteOutboxCapacityError } from '../src/remote/outbox.js';
import { OrderedAdmission } from '../src/daemon/admission.js';

const hostA = '019a0000-0000-7000-8000-000000000001';
const hostB = '019a0000-0000-7000-8000-000000000002';
const user = '019a0000-0000-7000-8000-000000000003';
const pat = 'fln_pat_connector_fixture_secret';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dispose of cleanups.splice(0).reverse()) await dispose(); });

class Clock implements RemoteClock {
  time = now;
  jobs = new Map<TimerHandle, { at: number; run(): void }>();
  now = () => this.time;
  setTimeout(run: () => void, ms: number): TimerHandle { const id = {}; this.jobs.set(id, { at: this.time + ms, run }); return id; }
  clearTimeout(id: TimerHandle): void { this.jobs.delete(id); }
  async tick(ms = 5): Promise<void> {
    this.time += ms;
    for (let turn = 0; turn < 40; turn++) {
      await new Promise<void>(resolve => setImmediate(resolve));
      for (const [id, job] of this.jobs) if (job.at <= this.time) { this.jobs.delete(id); job.run(); }
    }
  }
}
class Token implements ConnectorTokenSource {
  failure: Error | undefined;
  constructor(public host = hostA) {}
  token = vi.fn(async () => { if (this.failure) throw this.failure; return 'host-token-not-for-status'; });
  cachedToken = () => 'host-token-not-for-status';
  current = (): HostTokenInfo => ({ expiresAt: now + 100000, refreshAt: now + 90000,
    host: { id: this.host, teamId: user, userId: user }, supabase: { url: 'https://db.example.test', publishableKey: 'public' } });
  onChange = () => () => {};
  invalidate = vi.fn();
  stop = vi.fn();
}
class Platform implements ConnectorPlatform {
  registration: HostRegistration[] = [];
  publications: { session: PublishedSession; events: PublishedEvent[] }[] = [];
  rows: ClaimedCommand[] = [];
  notify = () => {};
  subscribed = () => {};
  constructor(readonly remoteSeq = new Map<string, number>()) {}
  realtime = {
    subscribeCommands: vi.fn((_host: string, listener: () => void, onSubscribed?: () => void) => {
      this.notify = listener; this.subscribed = onSubscribed ?? (() => {});
      return () => { this.notify = () => {}; this.subscribed = () => {}; };
    }),
    sendText: vi.fn((_event: TextStreamEvent) => {}),
  };
  register = vi.fn(async (registration: HostRegistration) => { this.registration.push(registration); });
  heartbeat = vi.fn(async () => {});
  publish = vi.fn(async (session: PublishedSession, events: PublishedEvent[]) => {
    this.publications.push({ session: parsePublishedSession(session), events: events.map(parsePublishedEvent) });
    const seq = Math.max(this.remoteSeq.get(session.session) ?? 0, events.at(-1)?.seq ?? 0);
    this.remoteSeq.set(session.session, seq); return seq;
  });
  claim = vi.fn(async () => this.rows);
  complete = vi.fn(async (_id: string, _outcome: RemoteCommandOutcome) => { this.rows = this.rows.filter(row => row.id !== _id); });
  close = vi.fn(async () => {});
}

async function fixture(options: { configured?: boolean; token?: Token; platform?: Platform; connector?: Partial<RemoteConnectorOptions>; wired?: boolean } = {}) {
  const f = await serverFixture(); const clock = new Clock();
  const configuration = new TestHostConfiguration({ definitions: [], assertCurrent: () => f.registry.assertAdmission() });
  let connector!: RemoteConnector;
  const server = new SessionServer({ registry: f.registry, configuration, models: f.root.runtime.session.modelRuntime, version: 'test', setupNeeds: () => connector?.setupNeeds() ?? [] });
  let secret: string | undefined = options.configured === false ? undefined : pat;
  const secrets = { read: vi.fn(async () => secret), write: vi.fn(async (_n: string, _k: string, value: string) => { secret = value; }), remove: vi.fn(async () => { secret = undefined; }) };
  const token = options.token ?? new Token(); const platform = options.platform ?? new Platform();
  const connectorOptions: RemoteConnectorOptions = { database: f.store.database, registry: f.registry, server, secretStorage: secrets, owner: f.owner,
    clock, heartbeatMs: 100, requestTimeoutMs: 1000, shutdownTimeoutMs: 10,
    tokenSource: () => token, connect: async source => { await source.token(); return platform; }, ...options.connector };
  connector = new RemoteConnector(connectorOptions); if (options.wired !== false) server.setRemote(connector);
  cleanups.push(async () => { await connector.stop(); server.close(); await f.dispose(); });
  connector.start(); await clock.tick();
  const id = f.root.sessionId;
  const change = (title = 'changed') => {
    f.root.runtime.session.setSessionName(title);
    return f.registry.projection(id).publish({ type: 'metadata.updated', title, state: 'open', residency: 'warm' }, { title });
  };
  return { ...f, id, clock, server, token, platform, secrets, change, get connector() { return connector; },
    async restart() { await connector.stop(); connector = new RemoteConnector(connectorOptions); server.setRemote(connector); connector.start(); await clock.tick(); await clock.tick(); },
  };
}

describe('RemoteConnector publication', () => {
  it('reads each idle remote record once per publication scan', async () => {
    const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick(0);
    const ids = [f.id, requestId(), requestId()];
    for (const id of ids.slice(1)) f.connector.store.setSession(id, { shared: false, origin: 'local', backfilled: false, unsharedPending: false });
    const session = vi.spyOn(f.connector.store, 'session'); f.platform.publish.mockClear();
    await f.clock.tick(100);
    expect(session.mock.calls.map(([id]) => id).sort()).toEqual(ids.sort());
    expect(f.platform.publish).not.toHaveBeenCalled();
  });

  it('acknowledges later publications without rewriting unchanged session records', async () => {
    const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick(0);
    const record = f.connector.store.session(f.id); const acked = f.connector.outbox.acked(f.id);
    const setSession = vi.spyOn(f.connector.store, 'setSession'); f.platform.publish.mockClear();
    f.change('first'); await f.clock.tick(0); f.change('second'); await f.clock.tick(0);
    expect(f.platform.publish).toHaveBeenCalledTimes(2); expect(setSession).not.toHaveBeenCalled();
    expect(f.connector.store.session(f.id)).toEqual(record);
    expect(f.connector.outbox.acked(f.id)).toBe(acked + 2); expect(f.connector.outbox.pendingCount()).toBe(0);
  });

  it('publishes same-tick changes immediately after the outbox group commit without a fixed delay', async () => {
    const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick(0); f.platform.publish.mockClear();
    const publish = f.platform.publish.getMockImplementation()!;
    f.platform.publish.mockImplementation(async (session, events) => {
      expect(f.store.database.outbox(session.session).map(row => row.seq)).toEqual(events.map(event => event.seq));
      return publish(session, events);
    });
    const time = f.clock.now(); f.change('first'); f.change('second');
    expect(f.platform.publish).not.toHaveBeenCalled(); await f.clock.tick(0);
    expect(f.clock.now()).toBe(time); expect(f.platform.publish).toHaveBeenCalledTimes(1);
    expect(f.platform.publish.mock.calls[0]![1].map(event => event.change)).toEqual([
      expect.objectContaining({ title: 'first' }), expect.objectContaining({ title: 'second' }),
    ]);
    expect(f.connector.outbox.pendingCount()).toBe(0);
  });

  it('publishes changes received in flight in the next pass without waiting for another timer', async () => {
    const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick(0); f.platform.publish.mockClear();
    let release!: () => void; const publish = f.platform.publish.getMockImplementation()!;
    f.platform.publish.mockImplementationOnce(async (session, events) => {
      await new Promise<void>(resolve => { release = resolve; }); return publish(session, events);
    });
    const time = f.clock.now(); f.change('in flight'); await f.clock.tick(0);
    f.change('next one'); f.change('next two'); await f.clock.tick(0);
    expect(f.platform.publish).toHaveBeenCalledTimes(1);
    release(); await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.clock.now()).toBe(time); expect(f.platform.publish).toHaveBeenCalledTimes(2);
    expect(f.platform.publish.mock.calls[1]![1].map(event => event.change)).toEqual([
      expect.objectContaining({ title: 'next one' }), expect.objectContaining({ title: 'next two' }),
    ]);
    expect(f.connector.outbox.pendingCount()).toBe(0);
  });

  it('publishes at most one backlog batch before another session in each round-robin pass', async () => {
    const f = await fixture(); const other = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, model: offlineModel });
    const [backlog, live] = [f.id, other.sessionId].sort() as [string, string];
    f.connector.setShared(backlog, true); f.connector.setShared(live, true); await f.clock.tick(0); f.platform.publish.mockClear();
    f.connector.outbox.append(backlog, Array.from({ length: 1100 }, (_, index) => ({ rev: index + 1, occurredAt: now,
      change: { type: 'metadata.updated' as const, title: `backlog ${index}`, state: 'open' as const, residency: 'warm' as const } })));
    for (const id of [backlog, live]) f.registry.projection(id).publish({ type: 'metadata.updated', title: 'live', state: 'open', residency: 'warm' });
    await f.clock.tick(0);
    expect(f.platform.publish.mock.calls.map(([session]) => session.session)).toEqual([backlog, live, backlog, backlog]);
    expect(f.platform.publish.mock.calls.map(([, events]) => events.length)).toEqual([500, 1, 500, 101]);
    expect(f.connector.outbox.pendingCount()).toBe(0);
  });

  it('observes 1000 shared text deltas without registry scans or remote database reads after warm-up', async () => {
    const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick();
    const publish = (f.registry as unknown as { publish(value: TextStreamEvent): void }).publish.bind(f.registry);
    publish({ v: 1, session: f.id, stream: { id: 'hot', message: 'hot-message', kind: 'text', offset: 0 }, text: 'a' });
    const list = vi.spyOn(f.registry, 'list'); const read = vi.spyOn(f.store.database, 'record'); const lines = vi.spyOn(f.store.database, 'outbox');
    const metadata = vi.spyOn(f.registry.options.store, 'findSessionMetadata');
    f.platform.realtime.sendText.mockClear();
    for (let offset = 1; offset <= 1000; offset++) publish({ v: 1, session: f.id, stream: { id: 'hot', message: 'hot-message', kind: 'text', offset }, text: 'a' });
    expect({ list: list.mock.calls.length, read: read.mock.calls.length, lines: lines.mock.calls.length }).toEqual({ list: 0, read: 0, lines: 0 });
    expect(metadata).not.toHaveBeenCalled();
    expect(f.platform.realtime.sendText).toHaveBeenCalledTimes(1000);
  });

  it.each([false, true])('skips disconnected text before session lookup when configured=%s', async configured => {
    const f = await fixture({ configured, connector: { connect: async () => { throw new PlatformError('retry', 'offline'); } } });
    const publish = (f.registry as unknown as { publish(value: TextStreamEvent): void }).publish.bind(f.registry);
    const list = vi.spyOn(f.registry, 'list'); const metadata = vi.spyOn(f.registry.options.store, 'findSessionMetadata');
    const session = vi.spyOn(f.connector.store, 'session'); const settings = vi.spyOn(f.connector.store, 'settings');
    for (let offset = 0; offset < 1000; offset++) publish({ v: 1, session: f.id, stream: { id: 'offline', message: 'offline-message', kind: 'text', offset }, text: 'a' });
    expect(list).not.toHaveBeenCalled(); expect(metadata).not.toHaveBeenCalled(); expect(session).not.toHaveBeenCalled(); expect(settings).not.toHaveBeenCalled();
    expect(f.platform.realtime.sendText).not.toHaveBeenCalled();
  });

  it('computes status with one registry scan and cached remote records', async () => {
    const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick(); f.connector.status();
    const list = vi.spyOn(f.registry, 'list'); const read = vi.spyOn(f.store.database, 'record'); const lines = vi.spyOn(f.store.database, 'outbox');
    expect(f.connector.status()).toMatchObject({ sessions: 1, pending: 0 });
    expect({ list: list.mock.calls.length, read: read.mock.calls.length, lines: lines.mock.calls.length }).toEqual({ list: 1, read: 0, lines: 0 });
  });

  it('does not treat a deleted session as shared through its cached root', async () => {
    const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick();
    expect(f.connector.isShared(f.id)).toBe(true);
    const deletion = { v: 1 as const, id: requestId(), op: 'session.delete' as const, session: f.id, params: {} };
    await new OrderedAdmission(f.store).submit(deletion, f.server.principal, admitted => ({
      response: f.registry.deleteAdmitted(admitted.request.id, f.id).then(() => ({ v: 1, re: deletion.id, outcome: 'accepted', result: {} })),
    }));
    expect(f.connector.isShared(f.id)).toBe(false); expect(() => f.connector.setShared(f.id, true)).toThrow();
    expect(f.connector.status().sessions).toBe(0);
  });

  it('does not connect or record without a PAT, but remembers /remote on for login', async () => {
    const f = await fixture({ configured: false }); f.connector.setShared(f.id, true); f.change(); await f.clock.tick();
    expect(f.token.token).not.toHaveBeenCalled(); expect(f.connector.outbox.pendingCount()).toBe(0);
    expect(f.connector.store.session(f.id)).toMatchObject({ shared: true, backfilled: false });
    expect(await f.connector.configure({ action: 'login', token: pat })).toMatchObject({ configured: true, state: 'connecting' });
    await f.clock.tick(); await f.clock.tick(); expect(f.platform.publications.length).toBeGreaterThan(0);
  });

  it('backfills all history pages oldest first, then publishes contiguous live changes and trims acknowledged entries', async () => {
    const f = await fixture();
    for (let index = 0; index < 270; index++) f.root.runtime.session.sessionManager.appendMessage({ role: 'user', content: [{ type: 'text', text: `message ${index}` }], timestamp: now + index });
    f.registry.projection(f.id).refresh();
    f.connector.setShared(f.id, true); f.change('after history'); await f.clock.tick();
    const events = f.platform.publications.flatMap(row => row.events);
    const messages = events.filter(event => event.change.type === 'message.completed');
    expect(messages).toHaveLength(270); expect(messages.map(event => event.occurredAt)).toEqual(messages.map(event => event.change.type === 'message.completed' ? event.change.message.timestamp : 0));
    expect(messages.map(event => event.change.type === 'message.completed' ? event.change.message.content[0] : undefined)).toEqual(Array.from({ length: 270 }, (_, index) => ({ type: 'text', text: `message ${index}` })));
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events[270]!.change.type).toBe('model.updated'); expect(events.filter(event => event.change.type === 'metadata.updated').at(-1)!.change).toMatchObject({ title: 'after history' });
    expect(f.connector.outbox.pendingCount()).toBe(0); expect(f.connector.outbox.acked(f.id)).toBe(events.length);
    expect(f.connector.store.session(f.id)).toMatchObject({ backfilled: true, hostId: hostA });
    expect(f.platform.publications[0]!.session.directory).toBe('work');
  }, 30_000);

  it('captures first share-all observation without duplicating its message', async () => {
    const f = await fixture(); await f.connector.configure({ action: 'share', share: 'all' }); await f.clock.tick();
    const child = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, model: offlineModel });
    child.runtime.session.sessionManager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'first' }], timestamp: now });
    f.registry.projection(child.sessionId).refresh(); await f.clock.tick();
    expect(f.platform.publications.flatMap(row => row.events).filter(event => event.session === child.sessionId && event.change.type === 'message.completed')).toHaveLength(1);
  });

  it('keeps implicit share-all decisions distinct from explicit /remote on and off', async () => {
    const f = await fixture(); await f.connector.configure({ action: 'share', share: 'all' }); await f.clock.tick();
    expect(f.connector.isShared(f.id)).toBe(true);
    await f.connector.configure({ action: 'share', share: 'on-request' }); await f.clock.tick();
    expect(f.connector.isShared(f.id)).toBe(false);
    f.connector.setShared(f.id, true); await f.clock.tick();
    await f.connector.configure({ action: 'share', share: 'all' }); f.connector.setShared(f.id, false);
    expect(f.connector.isShared(f.id)).toBe(false);
    await f.clock.tick(); const state = f.connector.store.session(f.id); await f.restart(); expect(f.connector.store.session(f.id)).toEqual(state);
  });

  it('writes shared:false exactly once, records no off-period events, and resumes without backfilling the gap', async () => {
    const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick();
    const before = f.connector.outbox.acked(f.id);
    f.connector.setShared(f.id, false); f.change('private gap'); await f.clock.tick(); await f.clock.tick(100);
    expect(f.platform.publications.filter(row => !row.session.shared)).toHaveLength(1);
    expect(f.platform.publications.find(row => !row.session.shared)!.events).toEqual([]);
    expect(f.connector.outbox.acked(f.id)).toBe(before);
    f.connector.setShared(f.id, true); f.change('shared again'); await f.clock.tick();
    const metadata = f.platform.publications.flatMap(row => row.events).filter(event => event.change.type === 'metadata.updated');
    expect(metadata.some(event => 'title' in event.change && event.change.title === 'private gap')).toBe(false);
    expect(metadata.at(-1)!.change).toMatchObject({ title: 'shared again' });
  });

  it('children follow their root and are unshared alongside it', async () => {
    const f = await fixture();
    const child = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, parentSessionId: f.id, rootSessionId: f.id, model: offlineModel });
    f.connector.setShared(child.sessionId, true); await f.clock.tick();
    expect(f.connector.isShared(f.id)).toBe(true); expect(f.connector.isShared(child.sessionId)).toBe(true);
    f.connector.setShared(f.id, false); await f.clock.tick();
    expect(f.connector.isShared(child.sessionId)).toBe(false);
    expect(f.platform.publications.filter(row => !row.session.shared).map(row => row.session.session).sort()).toEqual([f.id, child.sessionId].sort());
  });

  it('defers backfill for evicted sessions until they become resident', async () => {
    const f = await fixture(); await f.registry.evictIdle();
    f.connector.setShared(f.id, true); await f.clock.tick(); expect(f.connector.outbox.pendingCount()).toBe(0);
    await f.registry.restore(f.id); await f.clock.tick();
    expect(f.platform.publications.flatMap(row => row.events).some(event => event.change.type === 'model.updated')).toBe(true);
  });

  it('broadcasts text only while shared and connected and never stores it', async () => {
    const f = await fixture();
    const event: TextStreamEvent = { v: 1, session: f.id, stream: { id: 'stream', message: 'message', kind: 'text', offset: 0 }, text: 'hello ' };
    const publish = (f.registry as unknown as { publish(value: TextStreamEvent): void }).publish.bind(f.registry);
    publish(event); expect(f.platform.realtime.sendText).not.toHaveBeenCalled();
    f.connector.setShared(f.id, true); await f.clock.tick(); const seq = f.connector.outbox.acked(f.id);
    publish(event); expect(f.platform.realtime.sendText).toHaveBeenCalledWith(event);
    publish({ ...event, stream: { ...event.stream, offset: 6 }, text: pat }); expect(JSON.stringify(f.platform.realtime.sendText.mock.calls)).not.toContain(pat);
    expect(f.connector.outbox.pendingCount()).toBe(0); expect(f.connector.outbox.acked(f.id)).toBe(seq);
    f.connector.setShared(f.id, false); publish(event); expect(f.platform.realtime.sendText).toHaveBeenCalledTimes(2);
  });

  it('drops deltas and completion tails until the first publish succeeds, preserving stream offsets', async () => {
    const f = await fixture(); const publish = f.platform.publish.getMockImplementation()!;
    let release!: () => void;
    f.platform.publish.mockImplementationOnce(async (session, events) => {
      await new Promise<void>(resolve => { release = resolve; }); return publish(session, events);
    });
    f.connector.setShared(f.id, true); await f.clock.tick(0);
    expect(f.connector.store.session(f.id)).toMatchObject({ hostId: hostA, uploadAttempted: true });
    expect(f.connector.store.session(f.id)?.indexedHostId).toBeUndefined();
    const emit = (f.registry as unknown as { publish(value: TextStreamEvent): void }).publish.bind(f.registry);
    emit({ v: 1, session: f.id, stream: { id: 'tail', message: 'tail-message', kind: 'text', offset: 0 }, text: 'sk-' });
    f.registry.projection(f.id).publish({ type: 'message.completed', message: {
      id: 'tail-message', entryId: 'tail-entry', role: 'assistant', timestamp: now, content: [{ type: 'text', text: 'sk-' }],
    } });
    const event: TextStreamEvent = { v: 1, session: f.id, stream: { id: 'early', message: 'early-message', kind: 'text', offset: 0 }, text: 'hello ' };
    emit(event); expect(f.platform.realtime.sendText).not.toHaveBeenCalled();
    release(); await f.clock.tick(0);
    expect(f.connector.store.session(f.id)?.indexedHostId).toBe(hostA);
    emit({ ...event, stream: { ...event.stream, offset: 6 }, text: 'world ' });
    expect(f.platform.realtime.sendText).toHaveBeenCalledExactlyOnceWith({ ...event, stream: { ...event.stream, offset: 6 }, text: 'world ' });
    emit({ ...event, stream: { ...event.stream, id: 'new', offset: 0 } });
    expect(f.platform.realtime.sendText).toHaveBeenLastCalledWith({ ...event, stream: { ...event.stream, id: 'new', offset: 0 } });
  });

  it('does not index a rejected first publish or infer indexing from its persisted host and cursor on restart', async () => {
    const f = await fixture(); f.platform.publish.mockRejectedValueOnce(new PlatformError('invalid', 'rejected'));
    f.connector.setShared(f.id, true); await f.clock.tick(0);
    expect(f.connector.store.session(f.id)).toMatchObject({ hostId: hostA, uploadAttempted: true });
    expect(f.connector.store.session(f.id)?.indexedHostId).toBeUndefined();
    f.connector.outbox.fastForward(f.id, 100);
    const emit = (f.registry as unknown as { publish(value: TextStreamEvent): void }).publish.bind(f.registry);
    const event: TextStreamEvent = { v: 1, session: f.id, stream: { id: 'blocked', message: 'm', kind: 'text', offset: 0 }, text: 'hello ' };
    emit(event); expect(f.platform.realtime.sendText).not.toHaveBeenCalled();
    const publish = f.platform.publish.getMockImplementation()!; let release!: () => void;
    f.platform.publish.mockImplementationOnce(async (session, events) => {
      await new Promise<void>(resolve => { release = resolve; }); return publish(session, events);
    });
    await f.restart(); emit(event);
    expect(f.connector.outbox.acked(f.id)).toBe(100); expect(f.platform.realtime.sendText).not.toHaveBeenCalled();
    release(); await f.clock.tick(0);
    emit({ ...event, stream: { ...event.stream, id: 'after-retry' } });
    expect(f.platform.realtime.sendText).toHaveBeenCalledTimes(1);
  });

  it('indexes an idle shared session with zero events and restores that proof after restart without republishing', async () => {
    const f = await fixture();
    f.connector.store.setSession(f.id, { shared: true, explicit: true, origin: 'local', backfilled: true, unsharedPending: false });
    await f.clock.tick(100);
    expect(f.platform.publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ session: f.id, shared: true }), []);
    expect(f.connector.outbox.acked(f.id)).toBe(0);
    expect(f.connector.store.session(f.id)?.indexedHostId).toBe(hostA);
    f.platform.publish.mockClear(); await f.restart();
    const event: TextStreamEvent = { v: 1, session: f.id, stream: { id: 'restored', message: 'm', kind: 'text', offset: 0 }, text: 'hello ' };
    (f.registry as unknown as { publish(value: TextStreamEvent): void }).publish(event);
    expect(f.platform.publish).not.toHaveBeenCalled(); expect(f.platform.realtime.sendText).toHaveBeenCalledExactlyOnceWith(event);
  });

  it('indexes legacy shared sessions with an acknowledged cursor but no successful-index marker once', async () => {
    const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick(0);
    const record = f.connector.store.session(f.id)!; delete record.indexedHostId; f.connector.store.setSession(f.id, record);
    f.platform.publish.mockClear(); await f.restart();
    expect(f.platform.publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ session: f.id, shared: true }), []);
    expect(f.connector.store.session(f.id)?.indexedHostId).toBe(hostA);
  });

  it('keeps indexing session-scoped and clears it when re-pairing to another host', async () => {
    const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick(0);
    f.token.host = hostB; await f.connector.configure({ action: 'login', token: 'fln_pat_repaired' }); await f.clock.tick(0);
    const emit = (f.registry as unknown as { publish(value: TextStreamEvent): void }).publish.bind(f.registry);
    const event: TextStreamEvent = { v: 1, session: f.id, stream: { id: 'old-host', message: 'm', kind: 'text', offset: 0 }, text: 'hello ' };
    emit(event); expect(f.platform.realtime.sendText).not.toHaveBeenCalled();
    const other = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, model: offlineModel });
    const publish = f.platform.publish.getMockImplementation()!; let release!: () => void;
    f.platform.publish.mockImplementationOnce(async (session, events) => {
      await new Promise<void>(resolve => { release = resolve; }); return publish(session, events);
    });
    f.connector.setShared(other.sessionId, true); await f.clock.tick(0);
    emit({ ...event, session: other.sessionId }); expect(f.platform.realtime.sendText).not.toHaveBeenCalled();
    release(); await f.clock.tick(0);
    emit({ ...event, session: other.sessionId, stream: { ...event.stream, id: 'new-host' } }); emit(event);
    expect(f.connector.store.session(other.sessionId)?.indexedHostId).toBe(hostB);
    expect(f.platform.realtime.sendText).toHaveBeenCalledTimes(1);
    expect(f.platform.realtime.sendText).toHaveBeenLastCalledWith(expect.objectContaining({ session: other.sessionId }));
  });

  it('ignores a successful old-host publish response that arrives after re-pairing', async () => {
    const f = await fixture(); const publish = f.platform.publish.getMockImplementation()!; let release!: () => void;
    f.platform.publish.mockImplementationOnce(async (session, events) => {
      await new Promise<void>(resolve => { release = resolve; }); return publish(session, events);
    });
    const acknowledge = vi.spyOn(f.connector.outbox, 'acknowledge');
    f.connector.setShared(f.id, true); await f.clock.tick(0);
    f.token.host = hostB; await f.connector.configure({ action: 'login', token: 'fln_pat_repaired' }); await f.clock.tick(0);
    expect(f.connector.status().host?.id).toBe(hostB);
    const record = f.connector.store.session(f.id);
    expect(record).toMatchObject({ hostId: hostA, terminal: 'forbidden' });
    expect(record?.indexedHostId).toBeUndefined();
    release(); await f.clock.tick(0);
    expect(f.connector.store.session(f.id)).toEqual(record); expect(acknowledge).not.toHaveBeenCalled();
    (f.registry as unknown as { publish(value: TextStreamEvent): void }).publish({
      v: 1, session: f.id, stream: { id: 'stale-host', message: 'm', kind: 'text', offset: 0 }, text: 'hello ',
    });
    expect(f.platform.realtime.sendText).not.toHaveBeenCalled(); expect(f.platform.publish).toHaveBeenCalledTimes(1);
  });

  it('retries the identical batch after a disconnect and resumes from the durable ack after connector restart', async () => {
    const f = await fixture(); f.platform.publish.mockRejectedValueOnce(new PlatformError('retry', 'offline'));
    f.connector.setShared(f.id, true); await f.clock.tick();
    const failed = f.platform.publish.mock.calls[0]![1]; expect(f.connector.status().state).toBe('offline'); expect(f.connector.outbox.pendingCount()).toBe(failed.length);
    await f.clock.tick(1001); await f.clock.tick(); expect(f.platform.publish.mock.calls[1]![1]).toEqual(failed); expect(f.connector.outbox.pendingCount()).toBe(0);
    const acked = f.connector.outbox.acked(f.id); await f.restart();
    f.change(); await f.clock.tick(); expect(f.platform.publications.at(-1)!.events[0]!.seq).toBe(acked + 1);
  });

  it('retains an unacknowledged batch across restart', async () => {
    const f = await fixture(); f.platform.publish.mockRejectedValueOnce(new PlatformError('retry', 'offline'));
    f.connector.setShared(f.id, true); await f.clock.tick(); const failed = f.platform.publish.mock.calls[0]![1];
    await f.restart(); expect(f.platform.publish.mock.calls[1]![1]).toEqual(failed); expect(f.connector.outbox.pendingCount()).toBe(0);
  });

  it('recovers a sequence_gap inside the local range without renumbering', async () => {
    const f = await fixture(); f.platform.publish.mockRejectedValueOnce(new PlatformError('sequence_gap', 'gap', 2));
    f.connector.setShared(f.id, true); await f.clock.tick();
    expect(f.platform.publish.mock.calls[1]![1][0]!.seq).toBe(3); expect(f.connector.outbox.pendingCount()).toBe(0);
  });

  it.each(['sequence_gap', 'acknowledgement'] as const)('fast-forwards a rolled-back outbox from the platform %s and resumes publishing', async response => {
    const f = await fixture(); let platformLastSeq = 0;
    const publish = f.platform.publish.getMockImplementation()!;
    f.platform.publish.mockImplementationOnce(async (_session, events) => {
      platformLastSeq = events.at(-1)!.seq + 10;
      if (response === 'sequence_gap') throw new PlatformError('sequence_gap', 'gap', platformLastSeq);
      return platformLastSeq;
    });
    f.connector.setShared(f.id, true); await f.clock.tick(0);
    const [initial, resumed] = f.platform.publish.mock.calls;
    expect(resumed![1].map(event => event.seq)).toEqual(initial![1].map((_, index) => platformLastSeq + index + 1));
    expect(resumed![1].map(event => event.change)).toEqual(initial![1].map(event => event.change));
    expect(f.connector.outbox.acked(f.id)).toBe(platformLastSeq + resumed![1].length);
    expect(f.connector.outbox.nextSeq(f.id)).toBe(platformLastSeq + resumed![1].length + 1);
    expect(f.connector.status()).toMatchObject({ state: 'connected', pending: 0 }); expect(f.connector.status().message).toBeUndefined();
    f.platform.publish.mockImplementation(publish); f.change('after rollback'); await f.clock.tick(0);
    expect(f.platform.publish.mock.calls.at(-1)![1][0]!.seq).toBe(platformLastSeq + resumed![1].length + 1);
  });

  it('fast-forwards when the platform last_seq equals the local next sequence', async () => {
    const f = await fixture(); let nextSeq = 0;
    f.platform.publish.mockImplementationOnce(async (_session, events) => {
      nextSeq = events.at(-1)!.seq + 1; throw new PlatformError('sequence_gap', 'gap', nextSeq);
    });
    f.connector.setShared(f.id, true); await f.clock.tick(0);
    expect(f.platform.publish.mock.calls[1]![1][0]!.seq).toBe(nextSeq + 1);
    expect(f.connector.status()).toMatchObject({ state: 'connected', pending: 0 }); expect(f.connector.status().message).toBeUndefined();
  });

  it('includes changes appended during a rolled-back publication in the fast-forwarded batch', async () => {
    const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick(0); f.platform.publish.mockClear();
    let release!: () => void;
    f.platform.publish.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return 999; });
    f.change('before rollback'); await f.clock.tick(0); f.change('during rollback');
    release(); await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.platform.publish.mock.calls[1]![1].map(event => event.seq)).toEqual([1000, 1001]);
    expect(f.platform.publish.mock.calls[1]![1].map(event => event.change)).toEqual([
      expect.objectContaining({ title: 'before rollback' }), expect.objectContaining({ title: 'during rollback' }),
    ]);
    expect(f.connector.status()).toMatchObject({ state: 'connected', pending: 0 }); expect(f.connector.status().message).toBeUndefined();
  });

  it.each([
    ['same', 'gap'], ['advancing', 'gap'], ['same', 'acknowledgement'], ['advancing', 'acknowledgement'],
  ] as const)('blocks repeated %s inconsistent platform %s sequences instead of looping', async (kind, response) => {
    const f = await fixture(); let last = 999;
    f.platform.publish.mockImplementation(async () => {
      if (kind === 'advancing') last += 100;
      if (response === 'acknowledgement') return last;
      throw new PlatformError('sequence_gap', 'gap', last);
    });
    f.connector.setShared(f.id, true); await f.clock.tick(0);
    expect(f.platform.publish).toHaveBeenCalledTimes(2);
    expect(f.connector.status()).toMatchObject({ state: 'connected', message: expect.stringContaining('cannot be recovered') });
    f.change(); await f.clock.tick(100); expect(f.platform.publish).toHaveBeenCalledTimes(2);
  });

  it.each([-1, undefined])('stops only the affected session for unrecoverable sequence_gap %s', async last => {
    const f = await fixture(); f.platform.publish.mockRejectedValueOnce(new PlatformError('sequence_gap', 'gap', last));
    f.connector.setShared(f.id, true); await f.clock.tick();
    expect(f.connector.status()).toMatchObject({ state: 'connected', message: expect.stringContaining('cannot be recovered') });
    const calls = f.platform.publish.mock.calls.length; f.change(); await f.clock.tick(100); expect(f.platform.publish).toHaveBeenCalledTimes(calls);
    expect(f.connector.outbox.pendingCount()).toBeGreaterThan(0);
  });

  it.each(['session_deleted', 'forbidden'] as const)('drops and permanently fences a session on %s', async kind => {
    const f = await fixture(); f.platform.publish.mockRejectedValueOnce(new PlatformError(kind, kind));
    f.connector.setShared(f.id, true); await f.clock.tick();
    expect(f.connector.store.session(f.id)?.terminal).toBe(kind === 'session_deleted' ? 'deleted' : 'forbidden');
    expect(f.connector.outbox.pendingCount()).toBe(0); expect(f.connector.status().message).toContain(f.id);
    expect(() => f.change()).not.toThrow(); await f.clock.tick(); expect(f.platform.publish).toHaveBeenCalledTimes(1);
  });

  it('fences the old published copy when a new PAT pairs a different host', async () => {
    const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick();
    f.token.host = hostB; await f.connector.configure({ action: 'login', token: 'fln_pat_repaired' }); await f.clock.tick();
    expect(f.connector.status().host?.id).toBe(hostB); expect(f.connector.store.session(f.id)).toMatchObject({ terminal: 'forbidden', hostId: hostA });
    expect(f.connector.outbox.pendingCount()).toBe(0); f.change(); await f.clock.tick();
    expect(f.platform.publish).toHaveBeenCalledTimes(1);
  });

  it('isolates recorder failures from registry listeners and local session work', async () => {
    const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick();
    const observer = vi.fn(); f.registry.observe(observer); f.registry.observe(() => { throw new Error(pat); });
    const append = vi.spyOn(f.connector.outbox, 'append').mockImplementation(() => { throw new RemoteStorageError(pat); });
    expect(() => f.change()).not.toThrow(); expect(observer).toHaveBeenCalled();
    expect(() => f.change('after recording failure')).not.toThrow(); expect(append).toHaveBeenCalledTimes(1);
    expect(f.connector.status().message).toContain('Recording failed'); expect(JSON.stringify(f.connector.status())).not.toContain(pat);
    append.mockRestore(); await f.restart(); f.change('after restart'); await f.clock.tick();
    const titles = f.platform.publications.flatMap(row => row.events).filter(event => event.change.type === 'metadata.updated').map(event => event.change.title);
    expect(titles).not.toContain('after recording failure'); expect(titles).toContain('after restart');
  });
});

describe('RemoteConnector connection and commands', () => {
  it('claims on host-channel resubscribe without waiting for a notification or heartbeat', async () => {
    const f = await fixture(); const time = f.clock.now(); f.platform.claim.mockClear();
    f.platform.subscribed(); await f.clock.tick(0); expect(f.platform.claim).toHaveBeenCalledTimes(1);
    f.platform.subscribed(); await f.clock.tick(0); expect(f.platform.claim).toHaveBeenCalledTimes(2);
    expect(f.clock.now()).toBe(time); expect(f.platform.heartbeat).not.toHaveBeenCalled();
  });

  it('registers capabilities and canonical projects, then re-registers edits and heartbeats', async () => {
    const f = await fixture(); expect(f.platform.registration[0]).toMatchObject({ rowSchemaVersion: 1, capabilities: {
      operations: ['sessions.create', 'prompt', 'steer', 'cancel', 'interaction.answer'], interactionKinds: ['select', 'confirm', 'input', 'editor', 'tool_approval', 'dependency', 'form'], features: ['sessions.create.instructions'],
    } });
    const status = await f.connector.configure({ action: 'open_project', path: f.cwd }); await f.clock.tick();
    expect(status.projects[0]).toMatchObject({ path: f.cwd, name: 'work' }); expect(f.platform.registration.at(-1)!.projects).toEqual(status.projects);
    await f.connector.configure({ action: 'close_project', id: status.projects[0]!.id }); await f.clock.tick();
    expect(f.platform.registration.at(-1)!.projects).toEqual([]); await f.clock.tick(100); expect(f.platform.heartbeat).toHaveBeenCalled();
  });

  it.each(['invalid_pat', 'not_a_member', 'host_revoked', 'unsupported_schema'] as const)('stops on %s, retains outbox, notifies attached sessions, and resumes only on login', async reason => {
    const token = new Token(); const f = await fixture({ token }); f.connector.setShared(f.id, true); await f.clock.tick();
    await f.registry.attach(f.id, { principal: 'test', kind: 'tui' });
    token.failure = new HostTokenExchangeError(reason, pat, reason === 'unsupported_schema' ? { protocol: [1], rowSchemaVersion: [2] } : undefined);
    f.platform.publish.mockRejectedValueOnce(new PlatformError('revoked', pat)); f.change(); await f.clock.tick();
    expect(f.connector.status()).toMatchObject({ state: 'stopped', reason, pending: 1 }); expect(f.connector.setupNeeds()).toEqual([{ code: 'remote', message: expect.any(String) }]);
    expect(f.registry.projection(f.id).presentations()).toContainEqual(expect.objectContaining({ id: 'remote-stopped', kind: 'notification', level: 'warning' }));
    if (reason === 'unsupported_schema') expect(f.connector.status().supported).toEqual({ protocol: [1], rowSchemaVersion: [2] });
    expect(JSON.stringify(f.connector.status())).not.toContain(pat); await f.clock.tick(10000); expect(f.connector.status().state).toBe('stopped');
    token.failure = undefined; await f.connector.configure({ action: 'login', token: pat }); await f.clock.tick(); await f.clock.tick();
    expect(f.connector.status()).toMatchObject({ state: 'connected', pending: 0 });
  });

  it('reports a 426 on initial exchange without preventing local work', async () => {
    const token = new Token(); token.failure = new HostTokenExchangeError('unsupported_schema', 'unsupported', { protocol: [2], rowSchemaVersion: [2, 3] });
    const f = await fixture({ token }); expect(f.connector.status()).toMatchObject({ state: 'stopped', supported: { protocol: [2], rowSchemaVersion: [2, 3] } });
    expect(() => f.change()).not.toThrow(); expect(f.platform.register).not.toHaveBeenCalled();
  });

  it('claims on connect, notifications and heartbeat; sorts commands and only forgets after successful completion', async () => {
    const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick();
    const id = requestId(); f.platform.rows = [{ id, requester: user, command: { op: 'cancel', session: f.id, params: {} }, expiresAt: now + 1000, state: 'claimed' }];
    const submit = vi.spyOn(f.server, 'submitRemote');
    f.platform.complete.mockRejectedValueOnce(new PlatformError('retry', 'offline')); f.platform.notify(); await f.clock.tick();
    expect(f.connector.status().state).toBe('offline'); expect(submit).toHaveBeenCalledTimes(1);
    expect(f.store.database.record('command', id)).toBeDefined();
    await f.clock.tick(1001); expect(submit).toHaveBeenCalledTimes(1); expect(f.platform.complete).toHaveBeenCalledTimes(2); expect(f.store.database.record('command', id)).toBeUndefined();
    const claimed = f.platform.claim.mock.calls.length; await f.clock.tick(100); expect(f.platform.claim.mock.calls.length).toBeGreaterThan(claimed);
  });

  it('creates web sessions as always shared before dispatching the initial prompt', async () => {
    const f = await fixture(); const status = await f.connector.configure({ action: 'open_project', path: f.cwd });
    const id = requestId(); f.platform.rows = [{ id, requester: user, command: { op: 'sessions.create', params: { project: status.projects[0]!.id, prompt: { text: 'from web' } } }, expiresAt: now + 1000, state: 'claimed' }];
    const submit = vi.spyOn(f.server, 'submitRemote'); f.platform.notify(); await f.clock.tick();
    await vi.waitFor(() => expect(f.platform.complete).toHaveBeenCalled());
    const prompt = submit.mock.calls.find(([request]) => request.op === 'prompt')![0]; const session = prompt.session!;
    expect(f.connector.store.session(session)).toMatchObject({ origin: 'web', shared: true });
    expect(() => f.connector.setShared(session, false)).toThrow(/Web-created/u);
    expect(f.platform.complete.mock.calls[0]![1]).toMatchObject({ outcome: 'accepted', result: { sessionId: session } });
  });

  it('stops new command claims on drain, resumes on abandoned drain, closes platform and token on stop', async () => {
    const f = await fixture(); const count = f.platform.claim.mock.calls.length;
    f.connector.beginDrain(); f.platform.notify(); await f.clock.tick(100); expect(f.platform.claim).toHaveBeenCalledTimes(count);
    f.connector.endDrain(); await f.clock.tick(); expect(f.platform.claim.mock.calls.length).toBeGreaterThan(count);
    await f.connector.stop(); expect(f.token.stop).toHaveBeenCalled(); expect(f.platform.close).toHaveBeenCalled(); expect(f.clock.jobs.size).toBe(0);
  });

  it('logout removes only credentials, keeps records and pending outbox, and disconnects', async () => {
    const f = await fixture(); f.platform.publish.mockRejectedValueOnce(new PlatformError('retry', 'offline')); f.connector.setShared(f.id, true); await f.clock.tick();
    const count = f.connector.outbox.pendingCount(); expect(await f.connector.configure({ action: 'logout' })).toMatchObject({ configured: false, state: 'off', pending: count });
    expect(f.secrets.remove).toHaveBeenCalledWith('remote', 'pat'); expect(f.connector.store.session(f.id)?.backfilled).toBe(true); expect(f.token.stop).toHaveBeenCalled();
    expect(f.platform.close).toHaveBeenCalled();
  });

  it('never stores PATs or tokens in state files, errors or status', async () => {
    const f = await fixture({ configured: false }); f.secrets.write.mockRejectedValueOnce(new Error(pat));
    await expect(f.connector.configure({ action: 'login', token: pat })).rejects.toThrow('Remote configuration could not be saved');
    await f.connector.configure({ action: 'login', token: pat, apiUrl: 'https://app.example.test/base' }); await f.clock.tick();
    expect(f.connector.status().apiUrl).toBe('https://app.example.test');
    const settings = f.store.database.record('settings', 'settings')!;
    expect(settings).not.toContain(pat); expect(JSON.stringify(f.connector.status())).not.toContain(pat); expect(settings).not.toContain('host-token-not-for-status');
  });
});

async function wire(f: Awaited<ReturnType<typeof fixture>>) {
  const socket = await connectLocalIpc(f.owner.target);
  cleanups.push(async () => { socket.destroy(); });
  const decoder = new JsonLineDecoder();
  const pending = new Map<string, (value: Record<string, any>) => void>();
  socket.on('data', (data: Buffer) => { for (const frame of decoder.push(data)) {
    const value = frame as Record<string, any>; pending.get(value.re)?.(value);
  } });
  async function request(op: string, params = {}, session?: string) {
    const id = requestId();
    return new Promise<Record<string, any>>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`No response to ${op}`)); }, 2000);
      pending.set(id, value => { clearTimeout(timer); pending.delete(id); resolve(value); });
      socket.write(encodeFrame({ v: 1, id, op, params, ...(session ? { session } : {}) }));
    });
  }
  const hello = await request('hello', { protocol: 1, clientVersion: 'test', kind: 'tui', target: protocolTarget(f.owner.target), interactionKinds: [] });
  return { request, hello };
}

it('advertises remote operations only when wired, handles host ops without admission, and admits session.remote durably', async () => {
  const f = await fixture({ configured: false, wired: false }); await f.server.start();
  const before = await wire(f); expect(before.hello.result.operations).not.toEqual(expect.arrayContaining(['remote.status', 'remote.configure', 'session.remote']));
  f.server.setRemote(f.connector); const client = await wire(f);
  expect(client.hello.result.operations).toEqual(expect.arrayContaining(['remote.status', 'remote.configure', 'session.remote']));
  expect(await client.request('remote.status')).toMatchObject({ outcome: 'accepted', result: { configured: false, state: 'off' } });
  const response = await client.request('remote.configure', { action: 'login', token: pat });
  expect(response.outcome).toBe('accepted'); expect(JSON.stringify(response)).not.toContain(pat);
  expect(f.store.snapshot().requests).toHaveLength(0);
  await client.request('attach', { expected: f.owner.identity }, f.id);
  const result = await client.request('session.remote', { shared: true }, f.id);
  expect(result.outcome).toBe('accepted'); expect(f.store.snapshot().requests).toContainEqual(expect.objectContaining({ op: 'session.remote', phase: 'terminal' }));
  expect(JSON.stringify(f.store.snapshot())).not.toContain(pat);
});

it('composes actionable remote setup needs into host.status after a stop', async () => {
  const token = new Token(); token.failure = new HostTokenExchangeError('invalid_pat', pat);
  const f = await fixture({ token }); await f.server.start(); const client = await wire(f);
  expect(await client.request('host.status')).toMatchObject({ outcome: 'accepted', result: { setupNeeds: [{ code: 'remote', message: expect.stringContaining('/remote login') }] } });
});

it('executes claimed commands in UUID order', async () => {
  const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick();
  const first = '01a12345-0000-7000-8000-000000000001'; const second = '01a12345-0000-7000-8000-000000000002';
  f.platform.rows = [second, first].map(id => ({ id, requester: user, command: { op: 'cancel', session: f.id, params: {} }, expiresAt: now + 1000, state: 'claimed' }));
  f.platform.notify(); await f.clock.tick();
  expect(f.platform.complete.mock.calls.map(([id]) => id)).toEqual([first, second]);
});

it('preserves local operation and bounds shutdown while a platform request is hung', async () => {
  const f = await fixture(); f.platform.publish.mockImplementationOnce(() => new Promise(() => {}));
  f.connector.setShared(f.id, true); await f.clock.tick(); expect(() => f.change()).not.toThrow();
  const stopped = f.connector.stop(); await f.clock.tick(11); await stopped;
  expect(f.platform.close).toHaveBeenCalled(); expect(f.token.stop).toHaveBeenCalled();
  await f.clock.tick(1000); expect(f.connector.outbox.pendingCount()).toBeGreaterThan(0);
});

it('does not let an old hanging connect install itself after login or shutdown', async () => {
  let complete!: (platform: ConnectorPlatform) => void;
  const platform = new Platform();
  const f = await fixture({ connector: { connect: () => new Promise(resolve => { complete = resolve; }) } });
  const stopped = f.connector.stop(); await f.clock.tick(11); await stopped;
  complete(platform); await f.clock.tick();
  expect(platform.close).toHaveBeenCalledTimes(1); expect(platform.register).not.toHaveBeenCalled();
});

it('publishes an empty shared:true transition on re-enable without requiring a live change', async () => {
  const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick();
  f.connector.setShared(f.id, false); await f.clock.tick(); expect(f.platform.publications.at(-1)!.session.shared).toBe(false);
  f.connector.setShared(f.id, true); await f.clock.tick();
  expect(f.platform.publications.at(-1)).toMatchObject({ session: { shared: true }, events: [] });
  expect(f.connector.store.session(f.id)?.sharedPending).toBe(false);
});

it('reconnects instead of stopping when an expired RPC token can be refreshed successfully', async () => {
  const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick();
  f.platform.publish.mockRejectedValueOnce(new PlatformError('revoked', 'expired JWT')); f.change(); await f.clock.tick();
  expect(f.token.invalidate).toHaveBeenCalled(); expect(f.connector.status().state).toBe('offline');
  await f.clock.tick(1001); await f.clock.tick(); expect(f.connector.status()).toMatchObject({ state: 'connected', pending: 0 });
});

it('recovers a committed initial backfill after the separate session marker was lost', async () => {
  const f = await fixture(); f.connector.setShared(f.id, true); await new Promise<void>(resolve => setImmediate(resolve));
  const pending = f.connector.outbox.pending(f.id); expect(pending.length).toBeGreaterThan(0);
  const record = f.connector.store.session(f.id)!; f.connector.store.setSession(f.id, { ...record, backfilled: false });
  await f.restart(); expect(f.platform.publications.flatMap(row => row.events)).toHaveLength(pending.length);
  expect(f.connector.store.session(f.id)?.backfilled).toBe(true);
});

it('defers snapshot reads until the projection observer has returned and drops snapshot-covered live changes', async () => {
  const f = await fixture(); const snapshot = vi.spyOn(f.registry.projection(f.id), 'snapshot');
  f.connector.setShared(f.id, true); f.change('inside observer');
  expect(snapshot).not.toHaveBeenCalled(); expect(f.connector.outbox.pendingCount()).toBe(0);
  await f.clock.tick();
  expect(snapshot).toHaveBeenCalledTimes(1);
  expect(f.platform.publications.flatMap(row => row.events).filter(event => event.change.type === 'metadata.updated' && event.change.title === 'inside observer')).toHaveLength(1);
});

it('retries a non-storage backfill failure only on later publishable changes, with throttling', async () => {
  const f = await fixture(); const projection = f.registry.projection(f.id);
  const original = projection.snapshot.bind(projection);
  const snapshot = vi.spyOn(projection, 'snapshot').mockImplementation(() => { throw new Error('Session has no selected model'); });
  f.connector.setShared(f.id, true); await f.clock.tick();
  expect(snapshot).toHaveBeenCalledTimes(1); expect(f.connector.store.session(f.id)?.backfilled).toBe(false);
  for (let i = 0; i < 10; i++) f.change(`not yet ${i}`);
  await f.clock.tick(); expect(snapshot).toHaveBeenCalledTimes(1); expect(f.connector.outbox.pendingCount()).toBe(0);
  await f.clock.tick(1001);
  projection.setPresentation({ id: 'no-backfill', kind: 'notification', level: 'info', text: 'presentation only' });
  projection.publish({ type: 'catalog.updated', catalog: projection.catalog() });
  const publish = (f.registry as unknown as { publish(value: TextStreamEvent): void }).publish.bind(f.registry);
  publish({ v: 1, session: f.id, stream: { id: 'text', message: 'm', kind: 'text', offset: 0 }, text: 'text only' });
  await f.clock.tick(); expect(snapshot).toHaveBeenCalledTimes(1);
  snapshot.mockImplementation(original); f.change('retry succeeded'); await f.clock.tick(); await f.clock.tick();
  expect(snapshot).toHaveBeenCalledTimes(2); expect(f.connector.store.session(f.id)?.backfilled).toBe(true);
  expect(f.connector.status().message).toBeUndefined();
  expect(f.platform.publications.flatMap(row => row.events).filter(event => event.change.type === 'metadata.updated').map(event => event.change.title)).toEqual(['retry succeeded']);
});

it('skips and counts an unrepresentable change without consuming its sequence or stopping recording', async () => {
  const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick();
  const before = f.connector.outbox.acked(f.id);
  const publish = (f.registry as unknown as { publish(value: import('../src/daemon/projection.js').ProjectionOutput): void }).publish.bind(f.registry);
  publish({ v: 1, session: f.id, rev: 10000, change: { type: 'message.completed', message: {
    id: 'large', entryId: 'large', role: 'assistant', timestamp: now, content: [{ type: 'text', text: 'large structure' }], details: Array.from({ length: 600000 }, () => 0),
  } } });
  expect(f.connector.outbox.nextSeq(f.id)).toBe(before + 1);
  expect(f.connector.status().message).toContain('1 changes could not be published');
  f.change('still recording'); await f.clock.tick();
  expect(f.platform.publications.at(-1)!.events.map(event => event.seq)).toEqual([before + 1]);
  expect(f.connector.store.session(f.id)?.skippedChanges).toBe(1);
  await f.restart(); expect(f.connector.status().message).toContain('1 changes could not be published');
});

it('uploads nothing when unshared before first connect, then backfills fresh from seq 1', async () => {
  let connect!: (value: ConnectorPlatform) => void;
  const f = await fixture({ connector: { connect: () => new Promise(resolve => { connect = resolve; }) } });
  f.connector.setShared(f.id, true); f.change('before off'); await f.clock.tick();
  expect(f.connector.outbox.pendingCount()).toBeGreaterThan(0);
  f.connector.setShared(f.id, false);
  expect(f.connector.store.session(f.id)).toMatchObject({ backfilled: false, unsharedPending: false });
  expect(f.connector.outbox.pendingCount()).toBe(0);
  connect(f.platform); await f.clock.tick(); await f.clock.tick(); expect(f.platform.publish).not.toHaveBeenCalled();
  f.change('fresh on'); f.connector.setShared(f.id, true); await f.clock.tick();
  expect(f.platform.publications[0]!.events[0]!.seq).toBe(1);
  expect(f.platform.publications.flatMap(row => row.events).filter(event => event.change.type === 'metadata.updated').map(event => event.change.title)).toEqual(['fresh on']);
});

it.each([false, true])('drops pending outboxes and remote records on local delete (published=%s)', async published => {
  const f = await fixture({ connector: published ? {} : { connect: async () => { throw new PlatformError('retry', 'offline'); } } });
  f.connector.setShared(f.id, true); await f.clock.tick();
  if (published) f.platform.publish.mockRejectedValueOnce(new PlatformError('retry', 'offline'));
  f.change('pending before delete'); await f.clock.tick(); expect(f.connector.outbox.pendingCount()).toBeGreaterThan(0);
  const deletion = { v: 1 as const, id: requestId(), op: 'session.delete' as const, session: f.id, params: {} };
  await new OrderedAdmission(f.store).submit(deletion, f.server.principal, admitted => ({
    response: f.registry.deleteAdmitted(admitted.request.id, f.id).then(() => ({ v: 1, re: deletion.id, outcome: 'accepted', result: {} })),
  }));
  if (published) {
    expect(f.connector.store.session(f.id)?.unsharedPending).toBe(true);
    await f.clock.tick(1001); await f.clock.tick();
    expect(f.platform.publications.at(-1)).toMatchObject({ session: { shared: false }, events: [] });
  }
  expect(f.connector.outbox.pendingCount()).toBe(0); expect(f.connector.store.session(f.id)).toBeUndefined();
  expect(f.connector.outbox.sessions()).not.toContain(f.id); expect(f.connector.store.sessions()).not.toContain(f.id);
});

it('stops recording on the pending cap but still drains the durable backlog and warns about the hole', async () => {
  const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick();
  f.change('already pending');
  const append = vi.spyOn(f.connector.outbox, 'append').mockImplementation(() => { throw new RemoteOutboxCapacityError(); });
  f.change('over cap'); f.change('during cap block');
  expect(append).toHaveBeenCalledTimes(1); expect(f.connector.status().message).toContain('64 MiB');
  expect(f.connector.status().message).toContain('will not be uploaded');
  append.mockRestore(); await f.clock.tick(); expect(f.connector.outbox.pendingCount()).toBe(0);
  expect(f.platform.publications.at(-1)!.events).toHaveLength(1);
  expect(f.platform.publications.at(-1)!.events[0]!.change).toMatchObject({ title: 'already pending' });
});

it.each(['accepted', 'forbidden'] as const)('does not recreate a deleted remote record after an in-flight upload is %s', async outcome => {
  const f = await fixture(); let finish!: () => void;
  f.platform.publish.mockImplementationOnce((_session, events) => new Promise<number>((resolve, reject) => {
    finish = () => outcome === 'accepted' ? resolve(events.at(-1)!.seq) : reject(new PlatformError('forbidden', 'forbidden'));
  }));
  f.connector.setShared(f.id, true); await f.clock.tick(); expect(f.platform.publish).toHaveBeenCalledTimes(1);
  const deletion = { v: 1 as const, id: requestId(), op: 'session.delete' as const, session: f.id, params: {} };
  await new OrderedAdmission(f.store).submit(deletion, f.server.principal, admitted => ({
    response: f.registry.deleteAdmitted(admitted.request.id, f.id).then(() => ({ v: 1, re: deletion.id, outcome: 'accepted', result: {} })),
  }));
  finish(); await f.clock.tick(); await f.clock.tick();
  expect(f.connector.store.session(f.id)).toBeUndefined(); expect(f.connector.outbox.pendingCount()).toBe(0);
});

it('surfaces an asynchronous group-commit storage failure and stops later recording', async () => {
  const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick();
  const append = vi.spyOn(f.store.database, 'insertOutbox').mockImplementation(() => { throw new RemoteStorageError(pat); });
  f.change('failed group commit'); await new Promise<void>(resolve => setImmediate(resolve));
  expect(f.connector.status().message).toContain('Recording failed');
  expect(f.connector.status().message).toContain('will not be uploaded');
  expect(JSON.stringify(f.connector.status())).not.toContain(pat);
  const calls = append.mock.calls.length; f.change('after failed group commit');
  await new Promise<void>(resolve => setImmediate(resolve)); expect(append).toHaveBeenCalledTimes(calls);
});

it('bounds live changes held for an unavailable first snapshot', async () => {
  const f = await fixture(); vi.spyOn(f.registry.projection(f.id), 'snapshot').mockImplementation(() => { throw new Error('snapshot unavailable'); });
  f.connector.setShared(f.id, true); await f.clock.tick();
  const publish = (f.registry as unknown as { publish(value: import('../src/daemon/projection.js').ProjectionOutput): void }).publish.bind(f.registry);
  for (let index = 0; index < 8; index++) publish({ v: 1, session: f.id, rev: index + 1, change: { type: 'message.completed', message: {
    id: `m${index}`, entryId: `e${index}`, role: 'assistant', timestamp: now, content: [{ type: 'text', text: 'a'.repeat(700000) }],
  } } });
  const buffers = (f.connector as unknown as { buffered: Map<string, { bytes: number }> }).buffered;
  expect(buffers.get(f.id)!.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(f.connector.outbox.pendingCount()).toBe(0); expect(f.connector.store.session(f.id)?.backfilled).toBe(false);
});

it('redacts credentials split across streaming chunks while retaining offsets', async () => {
  const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick();
  const publish = (f.registry as unknown as { publish(value: TextStreamEvent): void }).publish.bind(f.registry);
  let offset = 0;
  for (const text of ['hello fln_', 'pat_secret', ' and Bear', 'er host-token', ' now']) {
    publish({ v: 1, session: f.id, stream: { id: 'safe', message: 'safe-message', kind: 'text', offset }, text });
    offset += text.length;
  }
  const sent = f.platform.realtime.sendText.mock.calls.map(([event]) => event);
  const text = sent.map(event => event.text).join('');
  expect(text).not.toContain('fln_pat_secret'); expect(text).not.toContain('host-token'); expect(text).toContain('hello');
  expect(sent[0]!.stream.offset).toBe(0);
  for (let index = 1; index < sent.length; index++) expect(sent[index]!.stream.offset).toBe(sent[index - 1]!.stream.offset + sent[index - 1]!.text.length);
});

it('serializes project registration and catches project changes during initial connect', async () => {
  const platform = new Platform(); let release!: () => void;
  platform.register.mockImplementationOnce(async registration => { platform.registration.push(registration); await new Promise<void>(resolve => { release = resolve; }); });
  const f = await fixture({ platform }); expect(f.connector.status().state).toBe('connecting');
  await f.connector.configure({ action: 'open_project', path: f.cwd }); release(); await f.clock.tick();
  expect(f.connector.status().state).toBe('connected'); expect(platform.registration.at(-1)!.projects).toHaveLength(1);
});

it('returns a safe actionable status when reopening an unreadable outbox', async () => {
  const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick(); f.connector.status();
  f.store.database.transaction(() => f.store.database.putRecord('outbox_cursor', f.id, pat));
  await f.restart();
  expect(() => f.change()).not.toThrow();
  expect(f.connector.status()).toMatchObject({ state: 'connected', message: expect.stringContaining('counts may be stale') });
  expect(JSON.stringify(f.connector.status())).not.toContain(pat);
});

it.each(['invalid', 'sequence_gap'] as const)('isolates a poison %s publication until daemon restart, without starving another session', async kind => {
  const f = await fixture();
  const other = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, model: offlineModel });
  const publish = f.platform.publish.getMockImplementation()!;
  f.platform.publish.mockImplementation(async (session, events) => {
    if (session.session === f.id) throw new PlatformError(kind, pat);
    return publish(session, events);
  });
  f.connector.setShared(f.id, true); f.connector.setShared(other.sessionId, true); await f.clock.tick();
  expect(f.connector.status()).toMatchObject({ state: 'connected', message: expect.stringContaining(f.id) });
  expect(JSON.stringify(f.connector.status())).not.toContain(pat);
  expect(f.platform.publications.some(row => row.session.session === other.sessionId)).toBe(true);
  expect(f.connector.outbox.pending(f.id).length).toBeGreaterThan(0);
  expect(f.connector.outbox.pending(other.sessionId)).toEqual([]);
  const attempts = () => f.platform.publish.mock.calls.filter(([session]) => session.session === f.id).length;
  expect(attempts()).toBe(1);
  f.change(); await f.clock.tick(100); expect(attempts()).toBe(1);
  f.platform.publish.mockImplementation(publish);
  f.platform.heartbeat.mockRejectedValueOnce(new PlatformError('retry', 'offline'));
  await f.clock.tick(100); await f.clock.tick(1001); await f.clock.tick();
  expect(f.connector.status().state).toBe('connected'); expect(attempts()).toBe(1);
  await f.restart();
  expect(attempts()).toBe(2); expect(f.connector.outbox.pending(f.id)).toEqual([]);
});

it.each(['invalid', 'sequence_gap'] as const)('records changes during %s publication quarantine and publishes the contiguous backlog after restart', async kind => {
  const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick();
  const acked = f.connector.outbox.acked(f.id);
  f.platform.publish.mockRejectedValueOnce(new PlatformError(kind, 'quarantined', kind === 'sequence_gap' ? -1 : undefined));
  f.change('triggers quarantine'); await f.clock.tick();
  expect(f.connector.status()).toMatchObject({ state: 'connected', message: expect.stringContaining(f.id) });
  const attempts = f.platform.publish.mock.calls.length;
  f.change('first change during quarantine'); f.change('second change during quarantine'); await f.clock.tick(100);
  expect(f.platform.publish).toHaveBeenCalledTimes(attempts);
  const pending = f.connector.outbox.pending(f.id);
  expect(pending.map(entry => entry.seq)).toEqual([acked + 1, acked + 2, acked + 3]);
  expect(pending.map(entry => entry.change)).toEqual([
    expect.objectContaining({ title: 'triggers quarantine' }),
    expect.objectContaining({ title: 'first change during quarantine' }),
    expect.objectContaining({ title: 'second change during quarantine' }),
  ]);
  await f.restart();
  expect(f.platform.publications.at(-1)!.events.map(event => event.seq)).toEqual(pending.map(entry => entry.seq));
  expect(f.platform.publications.at(-1)!.events.map(event => event.change)).toEqual(pending.map(entry => entry.change));
  expect(f.connector.outbox.pending(f.id)).toEqual([]); expect(f.connector.outbox.acked(f.id)).toBe(acked + 3);
  expect(f.connector.status()).toMatchObject({ state: 'connected', pending: 0 }); expect(f.connector.status().message).toBeUndefined();
});

it('forgets conflicting completed command outcomes and continues later commands', async () => {
  const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick();
  const first = '01a12345-0000-7000-8000-000000000001'; const second = '01a12345-0000-7000-8000-000000000002';
  f.platform.rows = [first, second].map(id => ({ id, requester: user, command: { op: 'cancel', session: f.id, params: {} }, expiresAt: now + 1000, state: 'claimed' }));
  f.platform.complete.mockRejectedValueOnce(new PlatformError('conflict', pat));
  f.platform.notify(); await f.clock.tick();
  expect(f.platform.complete.mock.calls.map(([id]) => id)).toEqual([first, second]);
  expect(f.connector.status().state).toBe('connected');
  expect(f.store.database.record('command', first)).toBeUndefined(); expect(f.store.database.record('command', second)).toBeUndefined();
});

it.each(['success', 'invalid', 'retry', 'revoked'] as const)('retries an invalid outcome once with a minimal rejection and proceeds after fallback %s', async fallback => {
  const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick();
  const first = '01a12345-0000-7000-8000-000000000001'; const second = '01a12345-0000-7000-8000-000000000002';
  f.platform.rows = [first, second].map(id => ({ id, requester: user, command: { op: 'cancel', session: f.id, params: {} }, expiresAt: now + 1000, state: 'claimed' }));
  f.platform.complete.mockRejectedValueOnce(new PlatformError('invalid', pat));
  if (fallback !== 'success') f.platform.complete.mockRejectedValueOnce(new PlatformError(fallback, pat));
  f.platform.notify(); await f.clock.tick();
  expect(f.platform.complete.mock.calls.map(([id]) => id)).toEqual([first, first, second]);
  expect(f.platform.complete.mock.calls[1]![1]).toEqual({ v: 1, re: first, outcome: 'rejected', error: {
    code: 'unavailable', message: 'Remote command outcome could not be published.', retryable: false,
  } });
  expect(f.connector.status().state).toBe('connected');
  if (fallback === 'success') expect(f.store.database.record('command', first)).toBeUndefined();
  else expect(f.store.database.record('command', first)).toBeDefined();
  expect(f.store.database.record('command', second)).toBeUndefined();
});

it('retains supported row schema versions from an RPC and clears stopped presentations on reconnect and heartbeat', async () => {
  const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick();
  await f.registry.attach(f.id, { principal: 'test', kind: 'tui' });
  f.token.failure = new HostTokenExchangeError('retry', 'offline');
  f.platform.publish.mockRejectedValueOnce(new PlatformError('unsupported_schema', pat, undefined, [2, 3]));
  f.change(); await f.clock.tick();
  expect(f.connector.status()).toMatchObject({ state: 'stopped', supported: { protocol: [], rowSchemaVersion: [2, 3] } });
  expect(f.token.invalidate).not.toHaveBeenCalled();
  expect(f.registry.projection(f.id).presentations().some(item => item.id === 'remote-stopped')).toBe(true);
  f.token.failure = undefined;
  await f.connector.configure({ action: 'login', token: pat }); await f.clock.tick();
  expect(f.registry.projection(f.id).presentations().some(item => item.id === 'remote-stopped')).toBe(false);
  f.registry.projection(f.id).setPresentation({ id: 'remote-stopped', kind: 'notification', level: 'warning', text: 'Stale warning' });
  await f.clock.tick(100);
  expect(f.registry.projection(f.id).presentations().some(item => item.id === 'remote-stopped')).toBe(false);
});

describe('re-review regressions', () => {
  it('quarantines a non-PT check violation without reconnecting or starving sessions and commands (P1)', async () => {
    const connect = vi.fn(async (source: ConnectorTokenSource) => { await source.token(); return platform; });
    const platform = new Platform(); const f = await fixture({ platform, connector: { connect } });
    const other = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, model: offlineModel });
    const publish = platform.publish.getMockImplementation()!;
    platform.publish.mockImplementation(async (session, events) => {
      if (session.session === f.id) throw parsePlatformError({ code: '23514', message: pat }, 400);
      return publish(session, events);
    });
    f.connector.setShared(f.id, true); f.connector.setShared(other.sessionId, true); await f.clock.tick();
    const count = platform.publish.mock.calls.filter(([session]) => session.session === f.id).length;
    const command = requestId();
    platform.rows = [{ id: command, requester: user, command: { op: 'cancel', session: other.sessionId, params: {} }, expiresAt: now + 1000, state: 'claimed' }];
    platform.notify(); await f.clock.tick();
    for (let i = 0; i < 10; i++) await f.clock.tick(70_000);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(platform.publish.mock.calls.filter(([session]) => session.session === f.id)).toHaveLength(count);
    expect(f.connector.store.session(f.id)?.terminal).toBeUndefined();
    expect(f.connector.outbox.pending(f.id).length).toBeGreaterThan(0);
    expect(platform.publications.some(row => row.session.session === other.sessionId)).toBe(true);
    expect(platform.complete).toHaveBeenCalledWith(command, expect.objectContaining({ outcome: 'accepted' }));
    expect(f.connector.status()).toMatchObject({ state: 'connected', message: expect.stringContaining(f.id) });
    expect(JSON.stringify(f.connector.status())).not.toContain(pat);
  });

  it('bounds repeated non-PT 403 publication rejection to one successful token re-exchange', async () => {
    const platform = new Platform();
    const connect = vi.fn(async (source: ConnectorTokenSource) => { await source.token(); return platform; });
    const f = await fixture({ platform, connector: { connect } });
    platform.publish.mockRejectedValue(parsePlatformError({ message: 'WAF blocked content' }, 403));
    f.connector.setShared(f.id, true); await f.clock.tick();
    expect(f.token.invalidate).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) await f.clock.tick(70_000);
    expect(connect).toHaveBeenCalledTimes(2); expect(platform.publish).toHaveBeenCalledTimes(2);
    expect(f.token.invalidate).toHaveBeenCalledTimes(1);
    expect(f.connector.store.session(f.id)?.terminal).toBeUndefined();
    expect(f.connector.outbox.pending(f.id).length).toBeGreaterThan(0);
    expect(f.connector.status()).toMatchObject({ state: 'connected', message: expect.stringContaining('after token exchange') });
  });

  it('persists upload intent before sending and unshares after a lost first response, retaining sequence across restart (P2)', async () => {
    const f = await fixture(); const publish = f.platform.publish.getMockImplementation()!;
    f.platform.publish.mockImplementationOnce(async (session, events) => {
      expect(f.connector.store.session(f.id)).toMatchObject({ uploadAttempted: true });
      const record = JSON.parse(f.store.database.record('session', f.id)!);
      expect(record.record.uploadAttempted).toBe(true);
      await publish(session, events);
      throw new PlatformError('retry', 'response lost after commit');
    });
    f.connector.setShared(f.id, true); await f.clock.tick();
    const first = f.platform.publications[0]!.events; const lastSeq = first.at(-1)!.seq;
    f.connector.setShared(f.id, false);
    expect(f.connector.store.session(f.id)).toMatchObject({ backfilled: true, uploadAttempted: true, unsharedPending: true });
    expect(f.connector.outbox.pending(f.id)).toHaveLength(first.length);
    await f.restart();
    expect(f.platform.publications.at(-1)).toMatchObject({ session: { shared: false }, events: [] });
    f.change('private interval'); f.connector.setShared(f.id, true); f.change('public after restart'); await f.clock.tick();
    const resumed = f.platform.publications.at(-1)!.events;
    expect(resumed.map(event => event.seq)).toEqual([...first.map(event => event.seq), lastSeq + 1]);
    expect(resumed.at(-1)!.change).toMatchObject({ title: 'public after restart' });
    expect(resumed.some(event => event.change.type === 'metadata.updated' && event.change.title === 'private interval')).toBe(false);
    expect(f.connector.outbox.nextSeq(f.id)).toBe(lastSeq + 2);
  });

  it('keeps claims and another session publishing after a per-session async storage failure (P3)', async () => {
    const platform = new Platform();
    const connect = vi.fn(async (source: ConnectorTokenSource) => { await source.token(); return platform; });
    const f = await fixture({ platform, connector: { connect } });
    const other = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, model: offlineModel });
    f.connector.setShared(f.id, true); f.connector.setShared(other.sessionId, true); await f.clock.tick();
    const insert = f.store.database.insertOutbox.bind(f.store.database);
    vi.spyOn(f.store.database, 'insertOutbox').mockImplementation((session, seq, bytes, data) => {
      if (session === f.id) throw new RemoteStorageError('disk full');
      return insert(session, seq, bytes, data);
    });
    f.change('failed commit'); await new Promise<void>(resolve => setImmediate(resolve));
    f.registry.projection(other.sessionId).publish({ type: 'metadata.updated', title: 'healthy session', state: 'open', residency: 'warm' });
    const id = requestId();
    platform.rows = [{ id, requester: user, command: { op: 'cancel', session: other.sessionId, params: {} }, expiresAt: now + 1000, state: 'claimed' }];
    platform.notify(); await f.clock.tick();
    for (let i = 0; i < 6; i++) await f.clock.tick(70_000);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(platform.complete).toHaveBeenCalledWith(id, expect.objectContaining({ outcome: 'accepted' }));
    expect(platform.publications.some(row => row.events.some(event => event.change.type === 'metadata.updated' && event.change.title === 'healthy session'))).toBe(true);
    expect(f.connector.status()).toMatchObject({ state: 'connected', message: expect.stringContaining('Recording failed') });
  });

  it('does not reconnect when outbox enumeration fails', async () => {
    const f = await fixture(); vi.spyOn(f.connector.outbox, 'sessions').mockImplementation(() => { throw new RemoteStorageError('disk full'); });
    await f.clock.tick(100); await f.clock.tick(100);
    expect(f.connector.status()).toMatchObject({ state: 'connected', message: expect.stringContaining('Recording failed') });
    expect(f.platform.close).not.toHaveBeenCalled(); expect(f.platform.claim.mock.calls.length).toBeGreaterThan(1);
  });

  it('uses one claim-batch time for slow commands and expires genuinely stale prior claims', async () => {
    const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick();
    const ids = ['01a12345-0000-7000-8000-000000000001', '01a12345-0000-7000-8000-000000000002', '01a12345-0000-7000-8000-000000000003'];
    const claimedAt = f.clock.time;
    f.platform.rows = ids.map((id, i) => ({ id, requester: user, command: { op: 'cancel', session: f.id, params: {} },
      expiresAt: i === 2 ? claimedAt - 10_000 : claimedAt + 1_000, claimedAt: i === 2 ? claimedAt - 70_000 : claimedAt, state: 'claimed' }));
    const submit = f.server.submitRemote.bind(f.server);
    const dispatch = vi.spyOn(f.server, 'submitRemote').mockImplementation(async (...args) => { f.clock.time += 120_000; return submit(...args); });
    f.platform.notify(); await f.clock.tick();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(f.platform.complete.mock.calls.map(([, result]) => result.outcome)).toEqual(['accepted', 'accepted', 'rejected']);
    expect(f.platform.complete.mock.calls[2]![1]).toMatchObject({ error: { code: 'expired' } });
  });

  it('counts a snapshot-covered oversized change only once', async () => {
    const f = await fixture(); const projection = f.registry.projection(f.id); const snapshot = projection.snapshot();
    const message = { id: 'oversized', entryId: 'oversized', role: 'assistant' as const, timestamp: now,
      content: [{ type: 'text' as const, text: 'large' }], details: Array.from({ length: 600_000 }, () => 0) };
    vi.spyOn(projection, 'snapshot').mockReturnValue({ ...snapshot, revision: snapshot.revision + 1, history: { ...snapshot.history, entries: [message] } });
    f.connector.setShared(f.id, true);
    (f.registry as unknown as { publish(value: import('../src/daemon/projection.js').ProjectionOutput): void }).publish({
      v: 1, session: f.id, rev: snapshot.revision + 1, change: { type: 'message.completed', message },
    });
    await f.clock.tick();
    expect(f.connector.store.session(f.id)?.skippedChanges).toBe(1);
  });

  it('runs another claim pass for a notification received while completion is deferred, without polling in a tight loop', async () => {
    const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick();
    const row = (id: string): ClaimedCommand => ({ id, requester: user, command: { op: 'cancel', session: f.id, params: {} }, expiresAt: now + 1000, state: 'claimed' });
    const first = requestId(); const second = requestId(); const initial = f.platform.claim.mock.calls.length;
    f.platform.claim.mockResolvedValueOnce([row(first)]).mockResolvedValueOnce([row(second)]).mockResolvedValue([]);
    f.platform.complete.mockRejectedValueOnce(new PlatformError('invalid', 'outcome rejected')).mockImplementationOnce(async () => {
      f.platform.notify(); throw new PlatformError('invalid', 'fallback rejected');
    });
    f.platform.notify(); await f.clock.tick();
    expect(f.platform.claim).toHaveBeenCalledTimes(initial + 2);
    expect(f.platform.complete.mock.calls.map(([id]) => id)).toEqual([first, first, second]);
    await f.clock.tick(); expect(f.platform.claim).toHaveBeenCalledTimes(initial + 2);
  });

  it('removes a locally deleted terminal record with a dropped zero cursor and no host', async () => {
    const f = await fixture();
    f.connector.store.setSession(f.id, { shared: false, origin: 'local', backfilled: false, unsharedPending: false, terminal: 'forbidden' });
    f.connector.outbox.drop(f.id);
    const deletion = { v: 1 as const, id: requestId(), op: 'session.delete' as const, session: f.id, params: {} };
    await new OrderedAdmission(f.store).submit(deletion, f.server.principal, admitted => ({
      response: f.registry.deleteAdmitted(admitted.request.id, f.id).then(() => ({ v: 1, re: deletion.id, outcome: 'accepted', result: {} })),
    }));
    expect(f.connector.store.session(f.id)).toBeUndefined(); expect(f.connector.status().message).toBeUndefined();
  });

  it('warns and blocks only the affected recorder when the total pending cap is reached', async () => {
    const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick();
    const append = vi.spyOn(f.connector.outbox, 'append').mockImplementation(() => { throw new RemoteOutboxCapacityError(f.id, 'total'); });
    f.change('over total cap'); f.change('still blocked');
    expect(append).toHaveBeenCalledTimes(1);
    expect(f.connector.status()).toMatchObject({ state: 'connected', message: expect.stringContaining('256 MiB total') });
  });
});

it('unshares a locally deleted session after an unacknowledged first upload before removing its record', async () => {
  const f = await fixture(); const publish = f.platform.publish.getMockImplementation()!;
  f.platform.publish.mockImplementationOnce(async (session, events) => {
    await publish(session, events); throw new PlatformError('retry', 'lost acknowledgement');
  });
  f.connector.setShared(f.id, true); await f.clock.tick();
  const record = f.connector.store.session(f.id)!; delete record.hostId;
  f.connector.store.setSession(f.id, record);
  const deletion = { v: 1 as const, id: requestId(), op: 'session.delete' as const, session: f.id, params: {} };
  await new OrderedAdmission(f.store).submit(deletion, f.server.principal, admitted => ({
    response: f.registry.deleteAdmitted(admitted.request.id, f.id).then(() => ({ v: 1, re: deletion.id, outcome: 'accepted', result: {} })),
  }));
  expect(f.connector.store.session(f.id)).toMatchObject({ uploadAttempted: true, unsharedPending: true });
  await f.clock.tick(1001); await f.clock.tick();
  expect(f.platform.publications.map(row => row.session.shared)).toEqual([true, false]);
  expect(f.connector.store.session(f.id)).toBeUndefined();
  expect(() => f.connector.outbox.nextSeq(f.id)).toThrow(/permanently/u);
});

it('isolates a corrupt durable session while publishing another session after restart', async () => {
  const f = await fixture(); const other = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, model: offlineModel });
  f.connector.setShared(f.id, true); f.connector.setShared(other.sessionId, true); await f.clock.tick();
  f.change('corrupt pending');
  f.registry.projection(other.sessionId).publish({ type: 'metadata.updated', title: 'intact backlog', state: 'open', residency: 'warm' });
  f.connector.outbox.flush(); await f.connector.stop();
  f.store.database.transaction(() => f.store.database.putRecord('outbox_cursor', f.id, 'invalid'));
  await f.restart();
  expect(f.connector.status()).toMatchObject({ state: 'connected', message: expect.stringContaining('counts may be stale') });
  expect(f.platform.publications.some(row => row.events.some(event => event.change.type === 'metadata.updated' && event.change.title === 'intact backlog'))).toBe(true);
});

it('counts an oversized buffered change not covered by the initial snapshot once', async () => {
  const f = await fixture(); const revision = f.registry.projection(f.id).snapshot().revision;
  f.connector.setShared(f.id, true);
  (f.registry as unknown as { publish(value: import('../src/daemon/projection.js').ProjectionOutput): void }).publish({
    v: 1, session: f.id, rev: revision + 10, change: { type: 'message.completed', message: {
      id: 'large-buffered', entryId: 'large-buffered', role: 'assistant', timestamp: now,
      content: [{ type: 'text', text: 'large' }], details: Array.from({ length: 600_000 }, () => 0),
    } },
  });
  await f.clock.tick();
  expect(f.connector.store.session(f.id)?.skippedChanges).toBe(1);
  expect(f.platform.publications.flatMap(row => row.events).filter(event => event.change.type === 'message.completed')).toEqual([]);
});


it('flushes the buffered outbox tail before stopping', async () => {
  const f = await fixture(); f.connector.setShared(f.id, true); await f.clock.tick();
  const entries = f.connector.outbox.append(f.id, [{ rev: 1000, occurredAt: now, change: {
    type: 'metadata.updated', title: 'shutdown tail', state: 'open', residency: 'warm',
  } }]);
  await f.connector.stop();
  expect(new RemoteOutbox(f.store.database).pending(f.id)).toEqual(entries);
});
