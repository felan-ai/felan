import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JsonLineDecoder, encodeFrame, parseHostRegistration, parsePublishedEvent, parsePublishedSession,
  parseRemoteCommand, parseRemoteCommandOutcome,
  type PublishedEvent, type PublishedSession, type Response as ProtocolResponse,
} from '@felan-ai/session-protocol';
import { connectLocalIpc } from '../src/daemon/ipc.js';
import { SessionServer } from '../src/daemon/server.js';
import { protocolTarget } from '../src/daemon/target.js';
import { RemoteConnector, type ConnectorTokenSource } from '../src/remote/connector.js';
import { PlatformClient } from '../src/remote/platform.js';
import { RemoteOutbox } from '../src/remote/outbox.js';
import { RemoteStore } from '../src/remote/state.js';
import { HostTokenExchangeError } from '../src/remote/token.js';
import { TestHostConfiguration } from './fixtures/host-services.js';
import { offlineModel } from './fixtures/registry.js';
import { gate, serverFixture } from './fixtures/server.js';
import { SupabaseFixtures, assertDatabase, probeSupabase, uuidV7, waitFor } from './support/remote-supabase.js';

const probe = await probeSupabase();
if (probe.reason) console.warn(`[remote-connector RPC/Realtime] SKIP: ${probe.reason}`);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  vi.restoreAllMocks();
  if (failures.length) throw new AggregateError(failures, 'Connector integration cleanup failed.');
});

interface Publication { session: PublishedSession; events: PublishedEvent[] }

async function fixture() {
  if (!probe.environment) throw new Error('Supabase probe did not provide an environment.');
  const fixtures = new SupabaseFixtures(probe.environment);
  cleanups.push(() => fixtures.cleanup());
  const account = await fixtures.owner();
  const host = account.hosts[0];
  const f = await serverFixture({ now: Date.now });
  cleanups.push(() => f.dispose());
  let connector!: RemoteConnector;
  const configuration = new TestHostConfiguration({ definitions: [], assertCurrent: () => f.registry.assertAdmission() });
  const server = new SessionServer({ registry: f.registry, configuration, models: f.root.runtime.session.modelRuntime,
    version: 'test', setupNeeds: () => connector.setupNeeds() });
  const submit = vi.spyOn(server, 'submitRemote').mockImplementation(async request => ({
    v: 1, re: request.id, outcome: 'accepted', result: {},
  } as ProtocolResponse));
  const publications: Publication[] = [];
  const sources: ConnectorTokenSource[] = [];
  const network: {
    losePublication?: ReturnType<typeof gate>;
    publicationCommitted: boolean;
    pauseCompletion?: ReturnType<typeof gate>;
    completionPaused: boolean;
    claims: number;
  } = { publicationCommitted: false, completionPaused: false, claims: 0 };
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/claim_session_commands')) network.claims++;
    if (url.pathname.endsWith('/complete_session_command') && network.pauseCompletion) {
      const pause = network.pauseCompletion; network.pauseCompletion = undefined; network.completionPaused = true;
      await pause.promise;
      throw new TypeError('Simulated disconnect before command completion.');
    }
    const publishing = url.pathname.endsWith('/publish_session_events');
    if (publishing) {
      const body = JSON.parse(String(init?.body));
      publications.push({ session: parsePublishedSession(body.p_session), events: body.p_events.map(parsePublishedEvent) });
    }
    const response = await fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(8_000) });
    if (publishing && response.ok && network.losePublication) {
      const pause = network.losePublication; network.losePublication = undefined; network.publicationCommitted = true;
      // The database committed, but the connector never receives its acknowledgement.
      await pause.promise;
      throw new TypeError('Simulated lost publication response.');
    }
    return response;
  };
  const create = () => {
    connector = new RemoteConnector({ database: f.store.database, registry: f.registry, server, owner: f.owner,
      secretStorage: { read: async () => account.pat, write: async () => {}, remove: async () => {} },
      apiUrl: fixtures.environment.apiUrl, name: 'Real connector integration', daemonVersion: '0.1.0',
      heartbeatMs: 100, requestTimeoutMs: 8_000, shutdownTimeoutMs: 100,
      tokenSource: () => {
        const minted = fixtures.tokenSource(host);
        let invalidated = false;
        const source: ConnectorTokenSource = {
          ...minted,
          token: vi.fn(async () => {
            if (invalidated) {
              const row = await fixtures.environment.admin.from('hosts').select('revoked_at').eq('id', host.id).single();
              assertDatabase(row, 'check host on token re-exchange');
              // Mimic the token endpoint only on re-exchange, after the real RPC rejects this host.
              if (row.data!.revoked_at) throw new HostTokenExchangeError('host_revoked', 'Host was revoked.');
              invalidated = false;
            }
            return minted.token();
          }),
          invalidate: vi.fn(() => { invalidated = true; }), stop: vi.fn(),
        };
        sources.push(source); return source;
      },
      connect: source => PlatformClient.connect(source, { fetch: transport }),
    });
    server.setRemote(connector); connector.start();
  };
  cleanups.push(async () => { await connector?.stop(); server.close(); });
  create();
  await waitFor(() => connector.status().state === 'connected', 'real connector registration');
  const id = f.root.sessionId;
  const change = (title: string, session = id) => {
    f.registry.binding(session)!.runtime.session.setSessionName(title);
    f.registry.projection(session).publish({ type: 'metadata.updated', title, state: 'open', residency: 'warm' }, { title });
  };
  const share = async (session = id) => {
    connector.setShared(session, true);
    await waitFor(() => Boolean(connector.store.session(session)?.hostId) && connector.outbox.pending(session).length === 0,
      'shared session backfill');
  };
  const events = async (session = id) => {
    const rows = await fixtures.environment.admin.from('session_events').select('*').eq('session_id', session).order('seq');
    assertDatabase(rows, 'read connector events');
    return rows.data!.map(row => parsePublishedEvent({ schemaVersion: row.schema_version, session: row.session_id,
      seq: row.seq, rev: row.rev, change: row.change, occurredAt: Date.parse(row.occurred_at) }));
  };
  const index = async (session = id) => {
    const row = await fixtures.environment.admin.from('host_sessions').select('*').eq('session_id', session).single();
    assertDatabase(row, 'read connector session index');
    const value = row.data!;
    const parsed = parsePublishedSession({ schemaVersion: value.schema_version, session: value.session_id,
      ...(value.parent_session_id === null ? {} : { parent: value.parent_session_id }), directory: value.directory,
      shared: value.shared, title: value.title, state: value.state, runState: value.run_state });
    return { ...parsed, lastSeq: value.last_seq as number, updatedAt: value.updated_at as string };
  };
  const commandRow = async (command: string) => {
    const row = await fixtures.environment.admin.from('session_commands').select('state,outcome,claimed_at').eq('id', command).single();
    assertDatabase(row, 'read connector command'); return row.data!;
  };
  const completed = async (command: string) => {
    await vi.waitFor(async () => { expect((await commandRow(command)).state).toBe('completed'); }, { timeout: 8_000, interval: 25 });
    return parseRemoteCommandOutcome((await commandRow(command)).outcome);
  };
  return { ...f, fixtures, account, host, id, server, submit, publications, sources, network, change, share, events, index, commandRow, completed,
    get connector() { return connector; },
    async restart() { await connector.stop(); create(); await waitFor(() => connector.status().state === 'connected', 'connector restart'); },
  };
}

async function hostStatus(f: Awaited<ReturnType<typeof fixture>>) {
  await f.server.start();
  const socket = await connectLocalIpc(f.owner.target);
  const decoder = new JsonLineDecoder();
  const pending = new Map<string, (value: unknown) => void>();
  socket.on('data', (data: Buffer) => {
    for (const frame of decoder.push(data)) {
      if (frame && typeof frame === 'object' && 're' in frame && typeof frame.re === 'string') pending.get(frame.re)?.(frame);
    }
  });
  const request = (op: string, params: object) => new Promise<unknown>((resolve, reject) => {
    const id = uuidV7();
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`No response to ${op}.`)); }, 2_000);
    pending.set(id, value => { clearTimeout(timeout); pending.delete(id); resolve(value); });
    socket.write(encodeFrame({ v: 1, id, op, params }));
  });
  try {
    const hello = await request('hello', { protocol: 1, clientVersion: 'test', kind: 'tui', target: protocolTarget(f.owner.target), interactionKinds: [] });
    expect(hello).toMatchObject({ outcome: 'accepted' });
    return await request('host.status', {});
  } finally { socket.destroy(); }
}

describe.skipIf(!probe.environment)(`real RemoteConnector against shared Supabase${probe.reason ? ` — SKIP: ${probe.reason}` : ''}`, () => {
  it('backfills history then publishes contiguous live changes and schema-conforming rows', async () => {
    const f = await fixture();
    for (let i = 0; i < 3; i++) f.root.runtime.session.sessionManager.appendMessage({ role: 'user', content: [{ type: 'text', text: `history ${i}` }], timestamp: Date.now() });
    f.registry.projection(f.id).refresh();
    await f.share();
    const backfill = await f.events();
    expect(backfill.filter(event => event.change.type === 'message.completed').map(event => event.change.type === 'message.completed' && event.change.message.content))
      .toEqual([0, 1, 2].map(i => [{ type: 'text', text: `history ${i}` }]));
    f.change('live one'); f.change('live two');
    await waitFor(() => f.connector.outbox.pendingCount() === 0, 'live publication acknowledgement');
    const rows = await f.events();
    expect(rows.map(row => row.seq)).toEqual(rows.map((_, i) => i + 1));
    expect(rows.slice(backfill.length).map(row => row.change)).toEqual([
      expect.objectContaining({ type: 'metadata.updated', title: 'live one' }),
      expect.objectContaining({ type: 'metadata.updated', title: 'live two' }),
    ]);
    expect(await f.index()).toMatchObject({ session: f.id, shared: true, directory: 'work', title: 'live two', lastSeq: rows.length });
    expect(f.connector.outbox.acked(f.id)).toBe(rows.length);
    const registered = await f.fixtures.environment.admin.from('hosts').select('*').eq('id', f.host.id).single();
    assertDatabase(registered, 'read connector registration');
    expect(parseHostRegistration({ name: registered.data!.name, daemonVersion: registered.data!.daemon_version,
      rowSchemaVersion: registered.data!.row_schema_version, capabilities: registered.data!.capabilities, projects: registered.data!.projects }))
      .toMatchObject({ name: 'Real connector integration', capabilities: { operations: expect.arrayContaining(['prompt', 'cancel']) } });
  }, 30_000);

  it('resumes a durable unacknowledged batch after restart from the platform last_seq without gaps or duplicates', async () => {
    const f = await fixture(); await f.share();
    const before = await f.events();
    const loss = gate(); f.network.losePublication = loss;
    f.change('committed without response');
    await waitFor(() => f.network.publicationCommitted, 'committed publication with lost response');
    f.change('queued during disconnect');
    const pending = f.connector.outbox.pending(f.id);
    expect(pending.map(row => row.seq)).toEqual([before.length + 1, before.length + 2]);
    expect((await f.index()).lastSeq).toBe(before.length + 1);
    await f.connector.stop(); loss.resolve();
    const reopened = new RemoteOutbox(f.store.database);
    expect(reopened.pending(f.id)).toEqual(pending);
    expect(reopened.acked(f.id)).toBe(before.length);
    await f.restart();
    await waitFor(() => f.connector.outbox.pendingCount() === 0, 'resumed outbox acknowledgement');
    const rows = await f.events();
    expect(rows.map(row => row.seq)).toEqual(rows.map((_, i) => i + 1));
    expect(rows.slice(before.length).map(row => row.change)).toEqual(pending.map(row => row.change));
    expect(rows).toHaveLength(before.length + 2);
    expect((await f.index()).lastSeq).toBe(rows.length);
    expect(f.connector.outbox.acked(f.id)).toBe(rows.length);
    expect(f.publications.filter(call => call.events.some(event => event.seq === before.length + 1))).toHaveLength(2);
  }, 30_000);

  it('tombstones terminally drop only the deleted session outbox while another session continues', async () => {
    const f = await fixture(); await f.share();
    const other = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, model: offlineModel });
    await f.share(other.sessionId);
    const before = await f.events();
    assertDatabase(await f.fixtures.environment.admin.from('session_tombstones').insert({ team_id: f.account.teamId, session_id: f.id, reason: 'user' }), 'tombstone published session');
    f.change('must be discarded'); f.change('other session continues', other.sessionId);
    await waitFor(() => f.connector.store.session(f.id)?.terminal === 'deleted' && f.connector.outbox.pendingCount() === 0,
      'terminal tombstone and surviving session publication');
    expect(new RemoteStore(f.store.database).session(f.id)?.terminal).toBe('deleted');
    expect(new RemoteOutbox(f.store.database).pending(f.id)).toEqual([]);
    const attempts = f.publications.filter(call => call.session.session === f.id).length;
    f.change('never publish again'); f.change('other session still continues', other.sessionId);
    await waitFor(() => f.connector.outbox.pendingCount() === 0, 'surviving session second publication');
    expect(f.publications.filter(call => call.session.session === f.id)).toHaveLength(attempts);
    expect(await f.events()).toEqual(before);
    expect(await f.index(other.sessionId)).toMatchObject({ title: 'other session still continues' });
  }, 30_000);

  it('stops on real host revocation, retains pending entries, and exposes remote setupNeeds through host.status', async () => {
    const f = await fixture(); await f.share();
    const before = await f.events();
    assertDatabase(await f.fixtures.environment.admin.from('hosts').update({ revoked_at: new Date().toISOString() }).eq('id', f.host.id), 'revoke connector host');
    f.change('pending after revocation');
    const pending = f.connector.outbox.pending(f.id);
    expect(pending).toHaveLength(1);
    await waitFor(() => f.connector.status().state === 'stopped', 'revoked connector stop');
    expect(f.sources[0]!.invalidate).toHaveBeenCalled();
    expect(f.connector.status()).toMatchObject({ state: 'stopped', reason: 'host_revoked', pending: 1 });
    expect(new RemoteOutbox(f.store.database).pending(f.id)).toEqual(pending);
    expect(await f.events()).toEqual(before);
    expect(await hostStatus(f)).toMatchObject({ outcome: 'accepted', result: {
      setupNeeds: [{ code: 'remote', message: expect.stringContaining('revoked') }],
    } });
  }, 30_000);

  it('claims owner commands, rejects non-owners and stale claims, and never claims expired pending rows', async () => {
    const f = await fixture(); await f.share(); f.connector.beginDrain();
    const outsider = await f.fixtures.owner();
    assertDatabase(await f.fixtures.environment.admin.from('team_members').insert({ team_id: f.account.teamId, user_id: outsider.userId, role: 'member' }), 'seed non-owner team member');
    const command = parseRemoteCommand({ op: 'prompt', session: f.id, params: { text: 'from web' } });
    const accepted = await f.fixtures.command(f.host, command);
    const forbidden = await f.fixtures.command(f.host, command);
    const expired = await f.fixtures.command(f.host, command);
    const stale = await f.fixtures.command(f.host, command);
    assertDatabase(await f.fixtures.environment.admin.from('session_commands').update({ requester_user_id: outsider.userId }).eq('id', forbidden), 'seed non-owner command');
    const past = new Date(Date.now() - 60_000).toISOString();
    assertDatabase(await f.fixtures.environment.admin.from('session_commands').update({ expires_at: past }).eq('id', expired), 'expire pending command');
    assertDatabase(await f.fixtures.environment.admin.from('session_commands').update({ state: 'claimed', claimed_at: past, expires_at: past }).eq('id', stale), 'seed stale claim');
    f.connector.endDrain();
    expect(await f.completed(accepted)).toEqual({ v: 1, re: accepted, outcome: 'accepted', result: {} });
    expect(await f.completed(forbidden)).toMatchObject({ re: forbidden, outcome: 'rejected', error: { code: 'forbidden' } });
    expect(await f.completed(stale)).toMatchObject({ re: stale, outcome: 'rejected', error: { code: 'expired' } });
    expect(f.submit).toHaveBeenCalledExactlyOnceWith({ v: 1, id: accepted, op: 'prompt', session: f.id, params: { text: 'from web' } }, {
      user: f.account.userId, command: accepted, interactionKinds: expect.arrayContaining(['confirm']),
    });
    expect((await f.commandRow(accepted)).claimed_at).not.toBeNull();
    const claims = f.network.claims;
    await waitFor(() => f.network.claims > claims, 'periodic claim after expired pending row');
    const expiredRow = await f.commandRow(expired);
    expect(expiredRow.claimed_at).toBeNull();
    // A concurrent expiry sweep may finish the pending row, but must never admit it.
    expect(['pending', 'expired']).toContain(expiredRow.state);
    if (expiredRow.state === 'expired') expect(parseRemoteCommandOutcome(expiredRow.outcome)).toMatchObject({ outcome: 'expired' });
    else expect(expiredRow.outcome).toBeNull();
  }, 30_000);

  it('reclaims a command after restart using its durable outcome without executing it twice', async () => {
    const f = await fixture(); await f.share();
    const pause = gate(); f.network.pauseCompletion = pause;
    const id = await f.fixtures.command(f.host, parseRemoteCommand({ op: 'cancel', session: f.id, params: {} }));
    await waitFor(() => f.network.completionPaused, 'completion interrupted after durable execution outcome');
    expect(await f.commandRow(id)).toMatchObject({ state: 'claimed', outcome: null });
    expect(f.submit).toHaveBeenCalledTimes(1);
    await f.connector.stop(); pause.resolve();
    await f.restart();
    expect(await f.completed(id)).toEqual({ v: 1, re: id, outcome: 'accepted', result: {} });
    expect(f.submit).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('writes shared:false once for /remote off and uploads nothing afterwards', async () => {
    const f = await fixture(); await f.share();
    const before = await f.events();
    f.connector.setShared(f.id, false); f.change('private after off');
    await waitFor(() => f.connector.store.session(f.id)?.unsharedPending === false, 'unshared index acknowledgement');
    const index = await f.index();
    expect(index).toMatchObject({ shared: false, lastSeq: before.length });
    const calls = f.publications.length;
    expect(f.publications.filter(call => !call.session.shared)).toEqual([{ session: expect.objectContaining({ session: f.id, shared: false }), events: [] }]);
    f.change('still private');
    const claims = f.network.claims;
    await waitFor(() => f.network.claims > claims + 1, 'two heartbeat publication passes while unshared');
    expect(f.publications).toHaveLength(calls);
    expect(await f.events()).toEqual(before);
    expect(await f.index()).toEqual(index);
    expect(f.connector.outbox.pendingCount()).toBe(0);
  }, 30_000);
});
