import { closeRemoteDatabases, openRemoteDatabase } from './remote-database.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PUBLISHED_CHANGE_TYPES, PUBLICATION_LIMITS, ROW_SCHEMA_VERSION, TextStreamEventSchema,
  parseHostRegistration, parseHostTokenClaims, parseHostTokenResponse, parsePublishedEvent, parsePublishedSession,
  parseRealtimeNotification, parseRemoteCommand, parseRemoteCommandOutcome, parseSchema,
  type KnownSessionChange, type PublishedSession, type TextStreamEvent,
} from '@felan-ai/session-protocol';
import { publicationBatches } from '../src/remote/batch.js';
import { RemoteCommandJournal } from '../src/remote/command-journal.js';
import { RemoteCommandExecutor, type RemoteCommandDependencies } from '../src/remote/commands.js';
import { publishableChange, publishedEvent, publishedSession } from '../src/remote/content.js';
import { RemoteOutbox } from '../src/remote/outbox.js';
import { PlatformError, parsePlatformError, type PlatformClient } from '../src/remote/platform.js';
import { HostTokenSource } from '../src/remote/token.js';
import {
  SupabaseFixtures, assertDatabase, probeSupabase, probeTokenEndpoint, registration, uuidV7, waitFor,
  type TestConnection, type TestOwner,
} from './support/remote-supabase.js';

// test-isolated.sh clears environment variables. Pass overrides after it, not before it:
// scripts/test-isolated.sh env FELAN_PLATFORM_DIR=/path/to/felan-platform SUPABASE_URL=http://127.0.0.1:54321 FELAN_API_URL=http://localhost:3000 pnpm --filter @felan-ai/daemon exec vitest run test/remote-supabase.integration.test.ts
const probe = await probeSupabase();
const endpointReason = await probeTokenEndpoint(probe);
for (const [suite, reason] of [['RPC/Realtime', probe.reason], ['token endpoint', endpointReason]]) {
  if (reason) console.warn(`[remote-supabase ${suite}] SKIP: ${reason}`);
}

function session(): PublishedSession {
  return publishedSession({ session: uuidV7(), cwd: '/tmp/connector-contract', title: 'Contract session', state: 'open', run: { state: 'idle' }, shared: true });
}

function changes(id: string): KnownSessionChange[] {
  const interaction = { id: 'confirm', scope: { kind: 'session' as const, session: id, root: id },
    request: { kind: 'confirm' as const, title: 'Continue?', message: 'Local console only' },
    state: 'waiting' as const, createdAt: Date.now(), authority: 'local-console' as const };
  return [
    { type: 'message.completed', message: { id: 'message', entryId: 'entry', role: 'assistant', timestamp: Date.now(), content: [{ type: 'text', text: 'Hello fln_pat_fixture_secret' }] } },
    { type: 'tool.updated', tool: { id: 'tool', message: 'message', name: 'bash', state: 'completed', output: 'x'.repeat(5_000), truncated: false } },
    { type: 'run.updated', run: { state: 'idle' } },
    { type: 'queue.updated', queue: [{ id: 'queued', kind: 'steer', prompt: { text: 'Next' }, origin: { kind: 'web', user: randomUUID(), command: uuidV7() } }] },
    { type: 'interaction.requested', interaction },
    { type: 'interaction.resolved', interaction: { ...interaction, state: 'cancelled', resolvedAt: Date.now(), result: { cancelled: true, reason: 'user' } } },
    { type: 'metadata.updated', title: 'Contract session', state: 'open', residency: 'warm' },
    { type: 'model.updated', model: { id: 'test', provider: 'test' }, thinking: 'off' },
    { type: 'child.updated', child: { session: uuidV7(), parent: id, root: id, title: 'Child', run: { state: 'idle' }, state: 'open' } },
    { type: 'stream.completion_only', stream: { message: 'message', id: 'stream', kind: 'assistant', reason: 'lost' } },
  ];
}

function append(box: RemoteOutbox, value: PublishedSession, count = 3): void {
  box.append(value.session, changes(value.session).slice(0, count).map((change, index) => {
    const published = publishableChange(change);
    if (!published) throw new Error(`Expected published change ${change.type}.`);
    return { rev: 4_096 + index * 3, occurredAt: Date.now(), change: published };
  }));
}

async function publishPending(platform: PlatformClient, box: RemoteOutbox, value: PublishedSession): Promise<number> {
  let lastSeq = box.acked(value.session);
  try {
    for (const batch of publicationBatches(value, box.pending(value.session).map(entry => publishedEvent(value.session, entry)))) {
      lastSeq = await platform.publish(value, batch);
      box.acknowledge(value.session, lastSeq);
    }
  } catch (error) {
    if (error instanceof PlatformError && error.kind === 'session_deleted') box.drop(value.session);
    throw error;
  }
  return lastSeq;
}

describe.skipIf(!probe.environment)(`shared Supabase connector contract${probe.reason ? ` — SKIP: ${probe.reason}` : ''}`, () => {
  let fixtures: SupabaseFixtures;
  let owner: TestOwner;
  let first: TestConnection;
  let second: TestConnection;
  let database: Awaited<ReturnType<typeof openRemoteDatabase>>['database'];
  const box = () => new RemoteOutbox(database);

  beforeAll(async () => {
    if (!probe.environment) throw new Error('Supabase probe did not provide an environment.');
    fixtures = new SupabaseFixtures(probe.environment);
    ({ database } = await openRemoteDatabase());
    owner = await fixtures.owner();
    first = await fixtures.connect(owner.hosts[0]);
    second = await fixtures.connect(owner.hosts[1]);
  }, 30_000);
  afterAll(async () => {
    try { await fixtures?.cleanup(); }
    finally { await closeRemoteDatabases(); }
  }, 30_000);

  it('registers and heartbeats with the scoped token, without granting host A host B publication rights', async () => {
    await first.platform.register(parseHostRegistration(registration));
    await first.platform.heartbeat();
    const { data, error } = await fixtures.environment.admin.from('hosts').select('*').eq('id', owner.hosts[0].id).single();
    assertDatabase({ error }, 'read registered host');
    expect(parseHostRegistration({ name: data.name, daemonVersion: data.daemon_version, rowSchemaVersion: data.row_schema_version,
      capabilities: data.capabilities, projects: data.projects })).toEqual(registration);
    expect(Date.parse(data.last_seen_at)).toBeGreaterThan(Date.now() - 30_000);
    const value = session();
    expect(await second.platform.publish(value, [])).toBe(0);
    const outbox = box(); append(outbox, value, 1);
    await expect(first.platform.publish(value, outbox.pending(value.session).map(entry => publishedEvent(value.session, entry))))
      .rejects.toMatchObject({ name: 'PlatformError', kind: 'forbidden' });
    const stored = await fixtures.environment.admin.from('host_sessions').select('host_id,last_seq').eq('session_id', value.session).single();
    assertDatabase(stored, 'read foreign session');
    expect(stored.data).toEqual({ host_id: owner.hosts[1].id, last_seq: 0 });
  });

  it('cannot read publication tables or personal keys directly with a host token', async () => {
    const value = session(); const outbox = box(); append(outbox, value, 1);
    await publishPending(first.platform, outbox, value);
    await fixtures.command(owner.hosts[0], parseRemoteCommand({ op: 'cancel', session: value.session, params: {} }));
    assertDatabase(await fixtures.environment.admin.from('session_tombstones').insert({ team_id: owner.teamId, session_id: uuidV7(), reason: 'user' }), 'seed read-test tombstone');
    for (const table of ['hosts', 'host_sessions', 'session_events', 'session_commands', 'session_tombstones', 'api_keys']) {
      const seeded = await fixtures.environment.admin.from(table).select('*').eq('team_id', owner.teamId);
      assertDatabase(seeded, `verify seeded ${table}`);
      expect(seeded.data!.length, `${table} has data to protect`).toBeGreaterThan(0);
      const result = await first.raw.from(table).select('*').eq('team_id', owner.teamId);
      if (result.error) {
        expect(result.status, table).toBe(403);
        expect(result.error.code, table).toBe('42501');
      } else expect(result.data, table).toEqual([]);
    }
  });

  it.each(['host revocation', 'membership removal'] as const)('keeps durable outbox entries after %s takes effect on the next RPC', async cause => {
    const disposable = await fixtures.owner();
    const host = disposable.hosts[0];
    const connection = await fixtures.connect(host);
    await connection.platform.heartbeat();
    const value = session(); const outbox = box(); append(outbox, value);
    if (cause === 'host revocation') {
      assertDatabase(await fixtures.environment.admin.from('hosts').update({ revoked_at: new Date().toISOString() }).eq('id', host.id), 'revoke host');
    } else {
      assertDatabase(await fixtures.environment.admin.from('team_members').delete().eq('team_id', host.teamId).eq('user_id', host.userId), 'remove member');
    }
    await expect(publishPending(connection.platform, outbox, value)).rejects.toMatchObject({ name: 'PlatformError', kind: 'revoked' });
    expect(new RemoteOutbox(database).pending(value.session)).toEqual(outbox.pending(value.session));
    expect(outbox.pending(value.session)).toHaveLength(3);
    expect(outbox.acked(value.session)).toBe(0);
  });

  it('drops a tombstoned session outbox durably instead of recreating deleted history', async () => {
    const value = session(); const outbox = box(); append(outbox, value);
    assertDatabase(await fixtures.environment.admin.from('session_tombstones').insert({ team_id: owner.teamId, session_id: value.session, reason: 'retention' }), 'seed retention tombstone');
    await expect(publishPending(first.platform, outbox, value)).rejects.toMatchObject({ name: 'PlatformError', kind: 'session_deleted' });
    const reopened = box();
    expect(reopened.pending(value.session)).toEqual([]);
    expect(() => append(reopened, value, 1)).toThrow(/permanently/u);
    const stored = await fixtures.environment.admin.from('host_sessions').select('session_id').eq('session_id', value.session);
    assertDatabase(stored, 'read tombstoned session');
    expect(stored.data).toEqual([]);
  });

  it('retries idempotently after a disconnect, reports sequence_gap with last_seq, and resumes the durable outbox', async () => {
    const value = session(); const outbox = box(); append(outbox, value);
    const batch = outbox.pending(value.session).slice(0, 2).map(entry => publishedEvent(value.session, entry));
    const connection = await fixtures.connect(owner.hosts[0]);
    expect(await connection.platform.publish(value, batch)).toBe(2);
    // Simulate losing the successful response before the local acknowledgement is committed.
    await connection.platform.close();
    const reopened = box(); const resumed = await fixtures.connect(owner.hosts[0]);
    expect(reopened.acked(value.session)).toBe(0);
    expect(await resumed.platform.publish(value, batch)).toBe(2);
    const stored = await fixtures.environment.admin.from('session_events').select('seq').eq('session_id', value.session).order('seq');
    assertDatabase(stored, 'read retried event batch');
    expect(stored.data).toEqual([{ seq: 1 }, { seq: 2 }]);
    await expect(resumed.platform.publish(value, [{ ...batch[0]!, seq: 4 }])).rejects.toMatchObject({ name: 'PlatformError', kind: 'sequence_gap', lastSeq: 2 });
    reopened.acknowledge(value.session, 2);
    expect(reopened.pending(value.session).map(entry => entry.seq)).toEqual([3]);
    expect(await publishPending(resumed.platform, reopened, value)).toBe(3);
    expect(reopened.pending(value.session)).toEqual([]);
    const final = await fixtures.environment.admin.from('host_sessions').select('last_seq').eq('session_id', value.session).single();
    assertDatabase(final, 'read resumed sequence');
    expect(final.data!.last_seq).toBe(3);
  });

  it('round-trips every published change and the index through the protocol parsers', async () => {
    const value = session(); const outbox = box(); append(outbox, value, PUBLISHED_CHANGE_TYPES.length);
    const expected = outbox.pending(value.session).map(entry => publishedEvent(value.session, entry));
    expect(expected.map(event => event.change.type).sort()).toEqual([...PUBLISHED_CHANGE_TYPES].sort());
    expect(JSON.stringify(expected)).not.toContain('fln_pat_fixture_secret');
    expect(await publishPending(first.platform, outbox, value)).toBe(expected.length);
    const rows = await fixtures.environment.admin.from('session_events').select('*').eq('session_id', value.session).order('seq');
    assertDatabase(rows, 'read published events');
    const parsed = rows.data!.map(row => parsePublishedEvent({ schemaVersion: row.schema_version, session: row.session_id,
      seq: row.seq, rev: row.rev, change: row.change, occurredAt: Date.parse(row.occurred_at) }));
    expect(parsed).toEqual(expected);
    const index = await fixtures.environment.admin.from('host_sessions').select('*').eq('session_id', value.session).single();
    assertDatabase(index, 'read published index');
    const row = index.data;
    expect(parsePublishedSession({ schemaVersion: row.schema_version, session: row.session_id,
      ...(row.parent_session_id === null ? {} : { parent: row.parent_session_id }), directory: row.directory,
      shared: row.shared, title: row.title, state: row.state, runState: row.run_state })).toEqual(value);
    expect(row.schema_version).toBe(ROW_SCHEMA_VERSION);
  });

  it('reclaims an unfinished command after disconnect and completes idempotently with a parsed indeterminate outcome', async () => {
    const host = await fixtures.host(owner); const connection = await fixtures.connect(host);
    const value = session(); await connection.platform.publish(value, []);
    const command = parseRemoteCommand({ op: 'cancel', session: value.session, params: {} });
    const id = await fixtures.command(host, command);
    expect(await connection.platform.claim()).toMatchObject([{ id, command, requester: owner.userId, state: 'claimed' }]);
    await connection.platform.close();
    const resumed = await fixtures.connect(host);
    expect(await resumed.platform.claim()).toMatchObject([{ id, command, state: 'claimed' }]);
    const outcome = parseRemoteCommandOutcome({ v: 1, re: id, outcome: 'indeterminate',
      error: { code: 'indeterminate', message: 'Command outcome was not recorded before disconnect.', retryable: false } });
    await resumed.platform.complete(id, outcome);
    await resumed.platform.complete(id, outcome);
    expect(await resumed.platform.claim()).toEqual([]);
    const row = await fixtures.environment.admin.from('session_commands').select('state,outcome').eq('id', id).single();
    assertDatabase(row, 'read completed command');
    expect(row.data!.state).toBe('completed');
    expect(parseRemoteCommandOutcome(row.data!.outcome)).toEqual(outcome);
  });

  it('recovers a dispatching command journal after a crash without executing the command again', async () => {
    const host = await fixtures.host(owner); const connection = await fixtures.connect(host);
    const value = session(); await connection.platform.publish(value, []);
    const id = await fixtures.command(host, parseRemoteCommand({ op: 'cancel', session: value.session, params: {} }));
    const [claimed] = await connection.platform.claim();
    if (!claimed || 'invalid' in claimed) throw new Error('Expected a valid claim.');
    const journal = new RemoteCommandJournal(database);
    const submit = vi.fn<RemoteCommandDependencies['submit']>(() => new Promise(() => {}));
    const dependencies: RemoteCommandDependencies = { submit, lookup: () => false, projects: () => [], isShared: () => true,
      markWebCreated: () => {}, capabilities: registration.capabilities, journal, hostIdentity: () => ({ kind: 'personal', userId: host.userId }) };
    void new RemoteCommandExecutor(dependencies).execute(claimed);
    await waitFor(() => journal.get(id)?.state === 'dispatching', 'durable command dispatch');
    expect(submit).toHaveBeenCalledTimes(1);
    await connection.platform.close();
    const resumed = await fixtures.connect(host); const [reclaimed] = await resumed.platform.claim();
    if (!reclaimed || 'invalid' in reclaimed) throw new Error('Expected a valid re-claim.');
    const recovered = new RemoteCommandJournal(database);
    const executor = new RemoteCommandExecutor({ ...dependencies, journal: recovered });
    const outcome = parseRemoteCommandOutcome(await executor.execute(reclaimed));
    expect(outcome).toMatchObject({ re: id, outcome: 'indeterminate' });
    expect(submit).toHaveBeenCalledTimes(1);
    await resumed.platform.complete(id, outcome); executor.forget(id);
    expect(recovered.get(id)).toBeUndefined(); expect(await resumed.platform.claim()).toEqual([]);
  });

  it('maps invalid outcomes and completion conflicts while accepting the minimal rejected fallback', async () => {
    const host = await fixtures.host(owner); const connection = await fixtures.connect(host);
    const value = session(); await connection.platform.publish(value, []);
    const id = await fixtures.command(host, parseRemoteCommand({ op: 'cancel', session: value.session, params: {} }));
    await connection.platform.claim();
    const rejected = { v: 1, re: id, outcome: 'rejected', error: {
      code: 'unavailable', message: 'Remote command outcome could not be published.', retryable: false,
    } } as const;
    const invalid = await connection.raw.rpc('complete_session_command', {
      p_id: id, p_outcome: { ...rejected, error: { ...rejected.error, message: 'line\nbreak' } },
    });
    expect(invalid.error).toMatchObject({ code: 'PT400', message: 'invalid_request' });
    expect(parsePlatformError(invalid.error, invalid.status).kind).toBe('invalid');
    await connection.platform.complete(id, rejected); await connection.platform.complete(id, rejected);
    await expect(connection.platform.complete(id, parseRemoteCommandOutcome({ v: 1, re: id, outcome: 'accepted', result: {} })))
      .rejects.toMatchObject({ kind: 'conflict' });
    const stored = await fixtures.environment.admin.from('session_commands').select('outcome').eq('id', id).single();
    assertDatabase(stored, 'read rejected outcome'); expect(parseRemoteCommandOutcome(stored.data!.outcome)).toEqual(rejected);
  });

  it('delivers private command, events, text, and outcome broadcasts with protocol-conforming payloads', async () => {
    const host = await fixtures.host(owner); const connection = await fixtures.connect(host);
    const value = session(); await connection.platform.publish(value, []);
    const viewer = await fixtures.viewer(owner.userId);
    const received: { event: string; payload: unknown }[] = [];
    const channel = viewer.channel(`session:${value.session}`, { config: { private: true } });
    for (const event of ['events', 'text', 'outcome']) channel.on('broadcast', { event }, message => { received.push({ event, payload: message.payload }); });
    channel.subscribe();
    const commands: unknown[] = [];
    const unsubscribe = connection.platform.realtime.subscribeCommands(host.id, notification => { commands.push(notification); });
    try {
      await waitFor(() => channel.state === 'joined' && connection.raw.getChannels().some(channel => channel.topic === `realtime:host:${host.id}` && channel.state === 'joined'), 'private channel joins');
      const id = await fixtures.command(host, parseRemoteCommand({ op: 'cancel', session: value.session, params: {} }));
      await waitFor(() => commands.length > 0, 'host command broadcast');
      expect(parseRealtimeNotification({ event: 'command', payload: commands[0] })).toEqual({ event: 'command', payload: { id, op: 'cancel' } });
      const outbox = box(); append(outbox, value, 1); await publishPending(connection.platform, outbox, value);
      await waitFor(() => received.some(message => message.event === 'events'), 'stored-event broadcast');
      expect(parseRealtimeNotification(received.find(message => message.event === 'events'))).toEqual({ event: 'events', payload: { seq: 1 } });
      const text = (stream: string, text: string): TextStreamEvent => ({ v: 1, session: value.session,
        stream: { id: stream, message: 'message', kind: 'assistant', offset: 0 }, text });
      // RemoteRealtime joins lazily; its display-only warm-up chunk may be dropped before SUBSCRIBED.
      connection.platform.realtime.sendText(text('warmup', 'warmup'));
      await waitFor(() => connection.raw.getChannels().some(channel => channel.topic === `realtime:session:${value.session}` && channel.state === 'joined'), 'host text send authorization');
      const content = '🦊'.repeat(9_000);
      connection.platform.realtime.sendText(parseSchema(TextStreamEventSchema, text('contract-text', content)));
      const chunks = () => received.filter(message => message.event === 'text').map(message => parseSchema(TextStreamEventSchema, message.payload)).filter(message => message.stream.id === 'contract-text');
      await waitFor(() => chunks().reduce((length, chunk) => length + chunk.text.length, 0) >= content.length, 'session text broadcasts');
      expect(chunks().map(chunk => chunk.text).join('')).toBe(content);
      expect(chunks().map(chunk => chunk.stream.offset)).toEqual([0, 8_192]);
      for (const chunk of chunks()) expect(Buffer.byteLength(chunk.text)).toBeLessThanOrEqual(PUBLICATION_LIMITS.textChunkBytes);
      expect(await connection.platform.claim()).toMatchObject([{ id }]);
      const outcome = parseRemoteCommandOutcome({ v: 1, re: id, outcome: 'accepted', result: {} });
      await connection.platform.complete(id, outcome);
      await waitFor(() => received.some(message => message.event === 'outcome'), 'command outcome broadcast');
      expect(parseRealtimeNotification(received.find(message => message.event === 'outcome'))).toEqual({ event: 'outcome', payload: { id, state: 'completed' } });
      const stored = await fixtures.environment.admin.from('session_events').select('type').eq('session_id', value.session);
      assertDatabase(stored, 'verify text was not stored');
      expect(stored.data).toEqual([{ type: 'message.completed' }]);
    } finally { unsubscribe(); await viewer.removeChannel(channel); }
  }, 30_000);
});

describe.skipIf(Boolean(endpointReason))(`local host-token endpoint${endpointReason ? ` — SKIP: ${endpointReason}` : ''}`, () => {
  let fixtures: SupabaseFixtures;
  let owner: TestOwner;
  const sources: HostTokenSource[] = [];
  const source = (pat: string, installId = randomUUID()) => {
    const result = new HostTokenSource({ apiUrl: fixtures.environment.apiUrl, pat, installId, name: registration.name, daemonVersion: registration.daemonVersion, requestTimeoutMs: 8_000 });
    sources.push(result); return result;
  };
  beforeAll(async () => {
    if (!probe.environment) throw new Error('Supabase probe did not provide an environment.');
    fixtures = new SupabaseFixtures(probe.environment); owner = await fixtures.owner();
  }, 30_000);
  afterAll(async () => { for (const value of sources) value.stop(); await fixtures?.cleanup(); }, 30_000);

  it('exchanges a seeded personal PAT through real HostTokenSource and parses its response and claims', async () => {
    const value = source(owner.pat);
    const token = await value.token();
    const response = parseHostTokenResponse({ ...value.current(), token });
    const payload = parseHostTokenClaims(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')));
    expect(response.host).toMatchObject({ teamId: owner.teamId, userId: owner.userId });
    expect(payload.sub).toBe(response.host.id);
    expect(payload.felan).toEqual({ kind: 'host', host_id: response.host.id, team_id: owner.teamId, user_id: owner.userId });
    expect(response.expiresAt).toBe(payload.exp * 1_000);
    expect(response.refreshAt).toBeLessThan(response.expiresAt);
  });

  it('preserves the host ID for the same (PAT, installId)', async () => {
    const installId = randomUUID(); const a = source(owner.pat, installId); const b = source(owner.pat, installId);
    await a.token(); await b.token();
    expect(a.current()!.host.id).toBe(b.current()!.host.id);
  });

  it('returns HTTP 401 and invalid_pat for a revoked personal key', async () => {
    const key = await fixtures.personalKey(owner.teamId, owner.userId);
    const installId = randomUUID(); await source(key.pat, installId).token();
    assertDatabase(await fixtures.environment.admin.from('api_keys').update({ revoked_at: new Date().toISOString() }).eq('id', key.apiKeyId), 'revoke personal key');
    const response = await fetch(`${fixtures.environment.apiUrl}/api/v1/hosts/token`, {
      method: 'POST', headers: { Authorization: `Bearer ${key.pat}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ installId, name: registration.name, daemonVersion: registration.daemonVersion, protocol: 1, rowSchemaVersion: ROW_SCHEMA_VERSION }),
      signal: AbortSignal.timeout(8_000), redirect: 'error',
    });
    expect(response.status).toBe(401);
    await expect(source(key.pat, installId).token()).rejects.toMatchObject({ name: 'HostTokenExchangeError', kind: 'invalid_pat' });
  });
});
