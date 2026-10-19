import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { parseClientEnvelope, parseOperationResult, parseRemoteCommandOutcome, requestTimestamp, type ClientEnvelope, type HostCapabilities, type RemoteCommand, type Response } from '@felan-ai/session-protocol';
import { RemoteCommandExecutor, remotePromptRequestId, type RemoteCommandDependencies } from '../src/remote/commands.js';
import { RemoteCommandJournal, type RemoteCommandJournalEntry } from '../src/remote/command-journal.js';
import { SessionServer, type SessionServerOptions } from '../src/daemon/server.js';
import { OrderedAdmission } from '../src/daemon/admission.js';
import { TestHostConfiguration } from './fixtures/host-services.js';
import { gate, serverFixture } from './fixtures/server.js';
import { closeRemoteDatabases, openRemoteDatabase } from './remote-database.js';
import { RemoteIntegrityError } from '../src/remote/state.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); await closeRemoteDatabases(); });
function id() {
  const time = Date.now().toString(16).padStart(12, '0');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${randomUUID().slice(1, 4)}-8${randomUUID().slice(1, 4)}-${randomUUID().slice(-12)}`;
}
const requester = randomUUID(); const session = randomUUID();
const expiresAt = Number.MAX_SAFE_INTEGER;
const capabilities: HostCapabilities = { operations: ['sessions.create', 'prompt', 'steer', 'cancel', 'interaction.answer'], interactionKinds: ['confirm'] };
function accepted(request: ClientEnvelope): Response {
  return { v: 1, re: request.id, outcome: 'accepted', result: request.op === 'sessions.create' ? { sessionId: session }
    : request.op === 'prompt' ? { runId: 'run' } : request.op === 'steer' ? { itemId: 'item' } : {} };
}
async function fixture(fault?: Parameters<typeof openRemoteDatabase>[0]) {
  const { database, reopen } = await openRemoteDatabase(fault);
  const journal = new RemoteCommandJournal(database);
  const submit = vi.fn<RemoteCommandDependencies['submit']>(async request => accepted(request));
  const options: RemoteCommandDependencies = { submit, owner: () => requester, lookup: vi.fn(() => true), projects: () => [{ id: 'open', name: 'Open project', path: '/opened' }],
    isShared: vi.fn(() => true), markWebCreated: vi.fn(), capabilities: structuredClone(capabilities), journal };
  return { database, reopen, journal, submit, options, executor: new RemoteCommandExecutor(options) };
}

it('caches journal capacity accounting across inserts, updates and acknowledgements', async () => {
  const f = await fixture(); const records = vi.spyOn(f.database, 'records');
  for (let index = 0; index < 3; index++) {
    const commandId = id();
    await f.executor.execute({ id: commandId, requester, expiresAt, command: { op: 'cancel', session, params: { runId: 'run' } } });
    f.executor.forget(commandId);
  }
  expect(records).toHaveBeenCalledExactlyOnceWith('command');
});

it.each(['admissible', 'forbidden', 'expired', 'invalid'] as const)('rejects an unrecorded %s command when the journal is full without dispatching', async kind => {
  const f = await fixture(); const journal = new RemoteCommandJournal(f.database, 1);
  const executor = new RemoteCommandExecutor({ ...f.options, journal });
  const command = { op: 'cancel', session, params: {} } satisfies RemoteCommand;
  const recorded = { id: id(), requester, expiresAt, command };
  const accepted = await executor.execute(recorded); f.submit.mockClear();
  const row = kind === 'invalid' ? { id: id(), invalid: 'invalid' }
    : { id: id(), requester: kind === 'forbidden' ? randomUUID() : requester, expiresAt: kind === 'expired' ? 0 : expiresAt, command };
  const rejected = { v: 1, re: row.id, outcome: 'rejected', error: { code: 'request_capacity', message: 'Remote command was rejected.', retryable: false } };
  await expect(executor.execute(row)).resolves.toEqual(rejected);
  await expect(executor.execute(row)).resolves.toEqual(rejected);
  expect(journal.get(row.id)).toBeUndefined();
  expect(await executor.execute(recorded)).toEqual(accepted);
  expect(f.submit).not.toHaveBeenCalled();
});

it.each([
  { op: 'prompt', session, params: { text: 'Hello' } },
  { op: 'steer', session, params: { text: 'Correction' } },
  { op: 'cancel', session, params: { runId: 'run' } },
  { op: 'interaction.answer', session, params: { interactionId: 'question', answer: { kind: 'confirm', confirmed: true } } },
] satisfies RemoteCommand[])('maps $op with the command identity and web requester', async command => {
  const f = await fixture(); const commandId = id();
  const outcome = await f.executor.execute({ id: commandId, requester, expiresAt, command });
  expect(f.submit).toHaveBeenCalledWith({ v: 1, id: commandId, ...command }, { user: requester, command: commandId, interactionKinds: ['confirm'] });
  expect(outcome).toEqual(accepted(parseClientEnvelope({ v: 1, id: commandId, ...command })));
  expect(parseRemoteCommandOutcome(outcome).outcome).toBe('accepted');
  expect(f.journal.get(commandId)).toMatchObject({ state: 'completed', outcome });
});

it.each([false, true])('creates in an opened project, preserving model/thinking and sharing before optional prompt: %s', async withPrompt => {
  const f = await fixture(); const commandId = id();
  f.submit.mockImplementation(async request => {
    expect(f.journal.get(commandId)).toMatchObject({ state: 'dispatching', request });
    if (request.op === 'prompt') expect(f.options.markWebCreated).toHaveBeenCalledWith(session);
    return accepted(request);
  });
  const outcome = await f.executor.execute({ id: commandId, requester, expiresAt, command: { op: 'sessions.create', params: {
    project: 'open', model: { provider: 'offline', id: 'fixture' }, thinking: 'high', ...(withPrompt ? { prompt: { text: 'Begin' } } : {}),
  } } });
  expect(f.submit.mock.calls[0]?.[0]).toEqual({ v: 1, id: commandId, op: 'sessions.create', params: {
    cwd: '/opened', model: { provider: 'offline', id: 'fixture' }, thinking: 'high',
  } });
  expect(outcome).toEqual({ v: 1, re: commandId, outcome: 'accepted', result: { sessionId: session } });
  expect(parseOperationResult('sessions.create', 'result' in outcome ? outcome.result : undefined)).toEqual({ sessionId: session });
  expect(f.submit).toHaveBeenCalledTimes(withPrompt ? 2 : 1);
  if (withPrompt) {
    const prompt = f.submit.mock.calls[1]![0];
    expect(prompt).toEqual({ v: 1, id: remotePromptRequestId(commandId), op: 'prompt', session, params: { text: 'Begin' } });
    expect(requestTimestamp(prompt.id)).toBe(requestTimestamp(commandId));
    expect(f.submit.mock.calls[1]![1].command).toBe(commandId);
  }
  expect(new RemoteCommandJournal(f.database).get(commandId)).toMatchObject({ state: 'completed', outcome });
});

it('rejects unknown projects, invalid rows and non-advertised operations without dispatch', async () => {
  const f = await fixture();
  expect(await f.executor.execute({ id: id(), requester, expiresAt, command: { op: 'sessions.create', params: { project: 'missing' } } }))
    .toMatchObject({ outcome: 'rejected', error: { code: 'not_found' } });
  const invalid = { id: id(), invalid: 'Do not echo sensitive row content' };
  const rejected = await f.executor.execute(invalid);
  expect(rejected).toMatchObject({ outcome: 'rejected', error: { code: 'invalid_request' } });
  expect(await f.executor.execute(invalid)).toEqual(rejected);
  expect(JSON.stringify(rejected)).not.toContain(invalid.invalid);
  f.options.capabilities.operations = ['sessions.create'];
  for (const command of [{ op: 'prompt', session, params: { text: 'No' } }, { op: 'sessions.create', params: { project: 'open', prompt: { text: 'No' } } }] satisfies RemoteCommand[]) {
    expect(await f.executor.execute({ id: id(), requester, expiresAt, command })).toMatchObject({ outcome: 'rejected', error: { code: 'forbidden' } });
  }
  expect(f.submit).not.toHaveBeenCalled();
});

it.each(['prompt', 'steer', 'cancel', 'interaction.answer'] as const)('refuses unshared %s including cancellation', async op => {
  const f = await fixture(); f.options.isShared = () => false;
  const command = { op, session, params: op === 'interaction.answer' ? { interactionId: 'i', answer: { kind: 'confirm', confirmed: true } } : op === 'cancel' ? {} : { text: 'No' } } as RemoteCommand;
  expect(await f.executor.execute({ id: id(), requester, expiresAt, command })).toMatchObject({ outcome: 'rejected', error: { code: 'forbidden' } });
  expect(f.submit).not.toHaveBeenCalled();
});

it.each([4_999, 5_000])('rejects an unjournaled claim expired beyond clock skew at %s without dispatch', async expiresAt => {
  const f = await fixture(); f.options.clock = { now: () => 10_000 };
  const row = { id: id(), requester, expiresAt, command: { op: 'cancel', session, params: {} } as RemoteCommand };
  const outcome = await f.executor.execute(row);
  expect(outcome).toMatchObject({ outcome: 'rejected', error: {
    code: 'expired', message: 'Remote command expired before admission.', retryable: false,
  } });
  expect(f.submit).not.toHaveBeenCalled();
  expect(f.journal.get(row.id)).toMatchObject({ state: 'completed', outcome });
});

it('dispatches a claim before expiry and replays its recorded outcome after expiry', async () => {
  const f = await fixture(); f.options.clock = { now: () => 1000 };
  const row = { id: id(), requester, expiresAt: 1001, command: { op: 'cancel', session, params: {} } as RemoteCommand };
  const outcome = await f.executor.execute(row);
  f.options.clock = { now: () => 2000 };
  expect(await new RemoteCommandExecutor(f.options).execute(row)).toEqual(outcome);
  expect(f.submit).toHaveBeenCalledOnce();
});

it.each([undefined, randomUUID()])('rejects a requester when the token owner is %s', async owner => {
  const f = await fixture(); f.options.owner = () => owner;
  const row = { id: id(), requester, expiresAt, command: { op: 'cancel', session, params: {} } as RemoteCommand };
  expect(await f.executor.execute(row)).toMatchObject({ outcome: 'rejected', error: {
    code: 'forbidden', message: 'Remote commands require the host owner.', retryable: false,
  } });
  expect(f.submit).not.toHaveBeenCalled();
});

async function interrupted(f: Awaited<ReturnType<typeof fixture>>, command: RemoteCommand) {
  const row = { id: id(), requester, expiresAt, command }; let entry: RemoteCommandJournalEntry | undefined;
  f.submit.mockImplementationOnce(async () => { entry = f.journal.get(row.id); throw new Error('Crash after dispatch'); });
  await f.executor.execute(row);
  f.journal.write(entry!); f.submit.mockClear();
  return row;
}

it.each([true, false])('recovers a dispatching journal only when admission still retains the request: %s', async retained => {
  const f = await fixture(); const row = await interrupted(f, { op: 'prompt', session, params: { text: 'Once' } });
  f.options.lookup = () => retained; f.submit.mockImplementation(async request => accepted(request));
  f.options.clock = { now: () => Number.MAX_SAFE_INTEGER };
  const outcome = await new RemoteCommandExecutor(f.options).execute(row);
  expect(outcome).toMatchObject({ outcome: retained ? 'accepted' : 'indeterminate' });
  expect(f.submit).toHaveBeenCalledTimes(retained ? 1 : 0);
  if (retained) expect(f.submit.mock.calls[0]![1]).toMatchObject({ requireRetained: true });
  expect(parseRemoteCommandOutcome(outcome).outcome).toBe(outcome.outcome);
});

it('returns a durable completed outcome, rejects changed identity, and never dispatches duplicates', async () => {
  const f = await fixture(); const row = { id: id(), requester, expiresAt, command: { op: 'prompt', session, params: { text: 'Once' } } as RemoteCommand };
  const [first, second] = await Promise.all([f.executor.execute(row), f.executor.execute(row)]);
  expect(second).toEqual(first);
  expect(await new RemoteCommandExecutor(f.options).execute(row)).toEqual(first);
  expect(await f.executor.execute({ ...row, requester: randomUUID() })).toMatchObject({ error: { code: 'request_conflict' } });
  expect(f.submit).toHaveBeenCalledOnce();
  f.executor.forget(row.id); expect(f.journal.get(row.id)).toBeUndefined();
});

it('keeps request identity stable when JSON key order changes', async () => {
  const f = await fixture(); const row = { id: id(), requester, expiresAt, command: { op: 'prompt', session, params: { text: 'Once' } } as RemoteCommand };
  const first = await f.executor.execute(row);
  expect(await f.executor.execute({ ...row, command: { params: { text: 'Once' }, session, op: 'prompt' } })).toEqual(first);
  expect(f.submit).toHaveBeenCalledOnce();
});

it('recovers the initial-prompt stage without creating a second session or prompt', async () => {
  const f = await fixture(); let interrupted: RemoteCommandJournalEntry | undefined;
  const row = { id: id(), requester, expiresAt, command: { op: 'sessions.create', params: { project: 'open', prompt: { text: 'Begin' } } } as RemoteCommand };
  f.submit.mockImplementation(async request => {
    if (request.op === 'prompt') { interrupted = f.journal.get(row.id); throw new Error('Interrupted prompt'); }
    return accepted(request);
  });
  await f.executor.execute(row); f.journal.write(interrupted!); f.submit.mockClear();
  f.submit.mockImplementation(async request => accepted(request));
  const outcome = await new RemoteCommandExecutor(f.options).execute(row);
  expect(outcome).toEqual({ v: 1, re: row.id, outcome: 'accepted', result: { sessionId: session } });
  expect(f.submit).toHaveBeenCalledOnce();
  expect(f.submit.mock.calls[0]![0]).toMatchObject({ op: 'prompt', id: remotePromptRequestId(row.id) });
  expect(f.submit.mock.calls[0]![1]).toMatchObject({ requireRetained: true });
});

it.each(['before_commit', 'after_commit'] as const)('does not submit when journaling fails at %s and recovers the committed state', async boundary => {
  const f = await fixture(at => { if (at === boundary) throw new Error('injected'); });
  const row = { id: id(), requester, expiresAt, command: { op: 'cancel', session, params: {} } as RemoteCommand };
  await expect(f.executor.execute(row)).rejects.toMatchObject({ code: 'storage_failure' });
  expect(f.submit).not.toHaveBeenCalled();
  const journal = new RemoteCommandJournal(f.reopen());
  expect(journal.get(row.id)).toEqual(boundary === 'before_commit' ? undefined : {
    id: row.id, identity: expect.stringMatching(/^[a-f0-9]{64}$/u), state: 'dispatching',
    request: { v: 1, id: row.id, ...row.command },
  });
  if (boundary === 'after_commit') {
    const executor = new RemoteCommandExecutor({ ...f.options, journal, lookup: () => false });
    expect(await executor.execute(row)).toMatchObject({ outcome: 'indeterminate' });
    expect(f.submit).not.toHaveBeenCalled();
  }
});

it('commits the dispatching journal before calling admission', async () => {
  const f = await fixture(); const row = { id: id(), requester, expiresAt, command: { op: 'cancel', session, params: {} } as RemoteCommand };
  f.submit.mockImplementation(async request => {
    expect(f.journal.get(row.id)).toMatchObject({ state: 'dispatching', request });
    expect(f.database.transaction(() => JSON.parse(f.database.record('command', row.id)!))).toMatchObject({ state: 'dispatching', request });
    return accepted(request);
  });
  expect(await f.executor.execute(row)).toMatchObject({ outcome: 'accepted' });
  expect(new RemoteCommandJournal(f.reopen()).get(row.id)).toMatchObject({ state: 'completed' });
});

it('bounds the private atomic journal and refuses corrupt recovery', async () => {
  const f = await fixture(); const row = { id: id(), requester, expiresAt, command: { op: 'cancel', session, params: {} } as RemoteCommand };
  const journal = new RemoteCommandJournal(f.database, 1);
  const executor = new RemoteCommandExecutor({ ...f.options, journal }); await executor.execute(row);
  expect(JSON.parse(f.database.record('command', row.id)!).state).toBe('completed');
  await expect(executor.execute({ ...row, id: id() })).resolves.toMatchObject({ outcome: 'rejected', error: { code: 'request_capacity' } });
  expect(f.submit).toHaveBeenCalledOnce();
  f.database.transaction(() => f.database.putRecord('command', row.id, '{broken'));
  await expect(executor.execute(row)).rejects.toBeInstanceOf(RemoteIntegrityError);
  await expect(new RemoteCommandExecutor({ ...f.options, journal: new RemoteCommandJournal(f.database) }).execute(row)).rejects.toBeInstanceOf(RemoteIntegrityError);
  expect(f.database.record('command', row.id)).toBe('{broken');
  expect(f.submit).toHaveBeenCalledOnce();
});

async function realServer() {
  const hold = gate(); const f = await serverFixture({ now: Date.now, onStream: () => hold.promise });
  const prepareRoot = vi.fn<NonNullable<SessionServerOptions['prepareRoot']>>(async request => ({ cwd: request.cwd, extensionPaths: [] }));
  const server = new SessionServer({ registry: f.registry, configuration: new TestHostConfiguration({ definitions: [], assertCurrent: () => f.registry.assertAdmission() }),
    models: f.root.runtime.session.modelRuntime, version: 'test', prepareRoot });
  cleanups.push(async () => { hold.resolve(); server.close(); await f.dispose(); });
  return { ...f, server, hold, prepareRoot };
}

it('uses shared admission without attachments and preserves web origin on runs and queued steering', async () => {
  const f = await realServer(); const command = id(); const origin = { kind: 'web', user: requester, command };
  const request = parseClientEnvelope({ v: 1, id: command, op: 'prompt', session: f.root.sessionId, params: { text: 'Run' } });
  const first = await f.server.submitRemote(request, { user: requester, command });
  expect(first.outcome).toBe('accepted');
  expect(f.store.session(f.root.sessionId).run.origin).toEqual(origin);
  expect(f.store.snapshot().requests.find(row => row.id === command)?.principal).toBe(`web:${requester}`);
  expect(await f.server.submitRemote(request, { user: requester, command })).toEqual(first);
  f.hold.resolve();
  await vi.waitFor(() => expect(f.store.session(f.root.sessionId).run.state).toBe('idle'));
  const steering = id();
  expect(await f.server.submitRemote(parseClientEnvelope({ v: 1, id: steering, op: 'steer', session: f.root.sessionId, params: { text: 'Steer' } }), { user: requester, command: steering })).toMatchObject({ outcome: 'accepted' });
  expect(f.registry.projection(f.root.sessionId).snapshot().queue[0]?.origin).toEqual({ ...origin, command: steering });
  expect(await f.server.submitRemote(request, { user: randomUUID(), command })).toMatchObject({ error: { code: 'request_conflict' } });
});

it('creates remotely with host paths and no prompt recipient, without preparing retained or replayed requests again', async () => {
  const f = await realServer(); const command = id();
  const path = join(f.cwd, 'host-extension.ts'); await writeFile(path, 'export default () => {};');
  f.prepareRoot.mockResolvedValue({ cwd: f.cwd, extensionPaths: [path] });
  const request = parseClientEnvelope({ v: 1, id: command, op: 'sessions.create', params: { cwd: f.cwd } });
  const response = await f.server.submitRemote(request, { user: requester, command });
  expect(response).toMatchObject({ outcome: 'accepted' }); if (response.outcome !== 'accepted') throw new Error('Create failed');
  expect(f.store.session((response.result as { sessionId: string }).sessionId).profile?.extensionPaths).toEqual([path]);
  expect(f.prepareRoot).toHaveBeenCalledExactlyOnceWith({ cwd: f.cwd }, { signal: expect.any(AbortSignal) });
  expect(await f.server.submitRemote(request, { user: requester, command })).toEqual(response);
  expect(await f.server.submitRemote(request, { user: requester, command, requireRetained: true })).toEqual(response);
  for (const extensions of [[], [path]]) {
    expect(await f.server.submitRemote({ ...request, id: id(), params: { ...request.params, extensions } } as ClientEnvelope, { user: requester, command })).toMatchObject({ error: { code: 'forbidden' } });
  }
  expect(await f.server.submitRemote(parseClientEnvelope({ v: 1, id: id(), op: 'close', session: f.root.sessionId, params: {} }), { user: requester, command })).toMatchObject({ error: { code: 'forbidden' } });
  expect(await f.server.submitRemote({ ...request, id: id() }, { user: requester, command, requireRetained: true })).toMatchObject({ outcome: 'indeterminate' });
  f.server.sealCommands();
  expect(await f.server.submitRemote({ ...request, id: id() }, { user: requester, command })).toMatchObject({ error: { code: 'busy' } });
  expect(await f.server.submitRemote(request, { user: requester, command })).toMatchObject({ outcome: 'accepted' });
  expect(f.prepareRoot).toHaveBeenCalledOnce();
});

it('deduplicates concurrent remote preparation and rejects a prepared target mismatch', async () => {
  const f = await realServer(); const held = gate();
  f.prepareRoot.mockImplementationOnce(async request => { await held.promise; return { cwd: request.cwd, extensionPaths: [] }; });
  const command = id(); const request = parseClientEnvelope({ v: 1, id: command, op: 'sessions.create', params: { cwd: f.cwd } });
  const first = f.server.submitRemote(request, { user: requester, command });
  const second = f.server.submitRemote(request, { user: requester, command });
  expect(f.prepareRoot).toHaveBeenCalledOnce(); held.resolve();
  const response = await first; expect(response.outcome).toBe('accepted'); expect(await second).toEqual(response);
  f.prepareRoot.mockResolvedValueOnce({ cwd: f.directory, extensionPaths: [] });
  expect(await f.server.submitRemote({ ...request, id: id() }, { user: requester, command })).toMatchObject({ error: { code: 'target_mismatch' } });
});

it('restores unattached sessions and refuses new requests to deleted sessions', async () => {
  const f = await realServer(); const session = f.root.sessionId;
  await f.registry.evictIdle(); expect(f.registry.binding(session)).toBeUndefined();
  const restore = vi.spyOn(f.registry, 'restore'); const command = id();
  expect(await f.server.submitRemote(parseClientEnvelope({ v: 1, id: command, op: 'steer', session, params: { text: 'Queued' } }), { user: requester, command })).toMatchObject({ outcome: 'accepted' });
  expect(restore).toHaveBeenCalledWith(session);
  f.registry.binding(session)!.runtime.session.clearQueue();
  const deletion = parseClientEnvelope({ v: 1, id: id(), op: 'session.delete', session, params: {} });
  expect(await new OrderedAdmission(f.store).submit(deletion, f.server.principal, admitted => ({ response: f.registry.deleteAdmitted(admitted.request.id, session).then(() => ({ v: 1, re: deletion.id, outcome: 'accepted', result: {} })) }))).toMatchObject({ outcome: 'accepted' });
  expect(await f.server.submitRemote(parseClientEnvelope({ v: 1, id: id(), op: 'prompt', session, params: { text: 'No' } }), { user: requester, command })).toMatchObject({ error: { code: 'not_found' } });
});

it.each([
  { claimedAt: 9_000, expiresAt: 9_500, batch: { startedAt: 10_000, receivedAt: 80_000 }, expected: 'accepted' },
  { claimedAt: 0, expiresAt: 6_000, batch: { startedAt: 10_000, receivedAt: 10_000 }, expected: 'accepted' },
  { claimedAt: 0, expiresAt: 5_000, batch: { startedAt: 10_000, receivedAt: 10_000 }, expected: 'rejected' },
])('uses server claim age and a fixed skew-adjusted batch time: $expected', async ({ claimedAt, expiresAt, batch, expected }) => {
  const f = await fixture(); f.options.clock = { now: () => 900_000 };
  const row = { id: id(), requester, claimedAt, expiresAt, command: { op: 'cancel', session, params: {} } as RemoteCommand };
  expect(await f.executor.execute(row, batch)).toMatchObject({ outcome: expected });
  expect(f.submit).toHaveBeenCalledTimes(expected === 'accepted' ? 1 : 0);
});
