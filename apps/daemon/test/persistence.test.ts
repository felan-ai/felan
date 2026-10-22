import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, unlink, writeFile, rename, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMITS, parseInteraction } from '@felan-ai/session-protocol';
import { acquireDaemonOwnership, type DaemonOwnership } from '../src/daemon/ownership.js';
import { DaemonControlStore, type ControlStoreOptions } from '../src/daemon/control-store.js';
import { ControlDatabase, type ControlChanges, type PersistenceBoundary } from '../src/daemon/persistence.js';
import { controlDatabasePath, execControlDatabase, readControlDatabase, writeControlDatabase } from './fixtures/control-database.js';

const supported = ['darwin', 'linux'].includes(process.platform);
const roots: string[] = [];
const owners: DaemonOwnership[] = [];
const stores: DaemonControlStore[] = [];
const databases: ControlDatabase[] = [];
const children: ChildProcess[] = [];
const now = 1_800_000_000_000;
function requestId(timestamp = now): string {
  const hex = timestamp.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7${randomUUID().slice(1, 4)}-8${randomUUID().slice(1, 4)}-${randomUUID().slice(-12)}`;
}
async function target() { const directory = await mkdtemp(join(tmpdir(), 's104-')); roots.push(directory); return { kind: 'isolated' as const, directory, namespaceId: randomUUID() }; }
async function open(options: ControlStoreOptions = {}) {
  const input = await target(); const owner = await acquireDaemonOwnership(input); owners.push(owner);
  const store = new DaemonControlStore(owner, { now: () => now, ...options }); stores.push(store);
  store.createSession({ id: 's', root: 's', cwd: '/fixture', piPath: join(owner.target.agentDir, 's.jsonl'), state: 'open', residency: 'warm', run: { state: 'idle' }, policy: { effective: 'host-default', generation: 0 }, title: '' });
  return { owner, store, input };
}
function reopen(owner: DaemonOwnership, options: ControlStoreOptions = {}) { const store = new DaemonControlStore(owner, { now: () => now, ...options }); stores.push(store); return store; }
const prompt = (id = requestId(), text = 'offline') => ({ v: 1, id, op: 'prompt', session: 's', params: { text } });
/** Raw database bytes, including any not yet checkpointed WAL frames. */
async function databaseBytes(directory: string): Promise<string> {
  return (await Promise.all(['', '-wal'].map(suffix => readFile(`${controlDatabasePath(directory)}${suffix}`, 'latin1').catch(() => '')))).join('');
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  }
  for (const store of stores.splice(0)) store.close();
  for (const database of databases.splice(0)) database.close();
  for (const owner of owners.splice(0)) await owner.release();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe.skipIf(!supported)('bounded daemon control persistence', () => {
  it('commits a retry identity, dispatch intent and exact outcome before returning; reload preserves them', async () => {
    const { owner, store } = await open(); const request = prompt();
    expect(store.admit(request, 'owner').value.phase).toBe('intent');
    expect(store.admit({ ...request, ignored: 'secret-extra', params: { ...request.params, ignored: 'extra' } }, 'owner').value.phase).toBe('intent');
    expect(() => store.admit({ ...request, params: { text: 'different' } }, 'owner')).toThrow(/already used/);
    expect(() => store.admit(request, 'another-owner')).toThrow(/already used/);
    expect(() => store.finishRequest(request.id, { v: 1, re: request.id, outcome: 'accepted', result: { runId: 'r' } })).toThrow(/dispatch intent/);
    store.markDispatched(request.id);
    const response = { v: 1, re: request.id, outcome: 'accepted', result: { runId: 'r' } };
    store.finishRequest(request.id, response); store.close();
    const reloaded = reopen(owner); reloaded.recover();
    expect(reloaded.admit(request, 'owner').value.response).toEqual(response);
    expect(() => reloaded.markDispatched(request.id)).toThrow(/never dispatch/);
    expect(reloaded.session('s').revision).toBeGreaterThan(1);
    const bytes = await databaseBytes(store.directory);
    expect(bytes).not.toContain('offline'); expect(bytes).not.toContain('secret-extra');
  });
  it('stores large legal attachment identities as a digest, not unbounded copies or launch secrets', async () => {
    const { store } = await open();
    const request = { ...prompt(), params: { text: '', attachments: [{ type: 'image', mimeType: 'image/png', data: Buffer.alloc(7 * 1024 * 1024).toString('base64') }] }, env: { SECRET: 'launch-value' } };
    const record = store.admit(request, 'owner').value;
    expect(record.identity.bytes).toBeGreaterThan(9 * 1024 * 1024);
    expect(JSON.stringify(readControlDatabase(store.directory).requests).length).toBeLessThan(4096);
    expect(JSON.stringify(store.snapshot())).not.toContain('launch-value');
  });
  it('coalesces message and queue projections, keeps revisions monotonic and advances policy generations', async () => {
    const { owner, store } = await open();
    for (let i = 0; i < 10; i++) store.project('s', [{ type: 'message', id: 'message', entryId: 'entry', state: 'observed' }, { type: 'queue', ids: [String(i)], identity: { sha256: '0'.repeat(64), bytes: i } }]);
    expect(store.session('s').projections).toHaveLength(2);
    const revision = store.session('s').revision;
    store.updateSession('s', { policy: { effective: 'acp-strict', generation: 1 } });
    expect(() => store.updateSession('s', { policy: { effective: 'host-default', generation: 1 } })).toThrow(/advance/);
    store.updateSession('s', { policy: { effective: 'host-default', generation: 2 } });
    store.close(); const reloaded = reopen(owner);
    expect(() => reloaded.updateSession('s', { title: 'before recovery' })).toThrow(/Recover/);
    reloaded.recover(); expect(reloaded.session('s').revision).toBeGreaterThan(revision);
    expect(() => reloaded.recover()).toThrow(/only valid/);
    expect(reloaded.session('s').projections.map(item => item.value)).toEqual([
      { type: 'message', id: 'message', entryId: 'entry', state: 'observed' }, { type: 'queue', ids: ['9'], identity: { sha256: '0'.repeat(64), bytes: 9 } }]);
  });
  it('rejects live-only tool and status views as durable projections', async () => {
    const { store } = await open(); const before = store.snapshot();
    expect(() => store.project('s', [{ type: 'tool', tool: { id: 'tool', name: 'fake', message: 'm', state: 'running', output: 'secret output', truncated: false } } as never])).toThrow();
    expect(() => store.project('s', [{ type: 'status', id: 'status', text: 'status' } as never])).toThrow();
    expect(store.snapshot()).toEqual(before);
  });
  it('writes only changed rows and reloads every table in its in-memory order', async () => {
    let commits = 0;
    const { owner, store } = await open({ fault: at => { if (at === 'before_commit') commits++; } });
    store.createSession({ id: 'other', root: 'other', cwd: '/fixture', piPath: join(owner.target.agentDir, 'other.jsonl'), state: 'open', residency: 'warm', run: { state: 'idle' }, policy: { effective: 'host-default', generation: 0 }, title: '' });
    for (const id of ['first', 'second', 'third']) store.putResource({ id, session: 's', root: 's', kind: 'detached', state: 'running', reference: join(owner.target.agentDir, `${id}.json`), startIdentity: id, updatedAt: now });
    store.putResource({ id: 'first', session: 's', root: 's', kind: 'detached', state: 'exited', reference: join(owner.target.agentDir, 'first.json'), startIdentity: 'first', updatedAt: now });
    store.updateSession('s', { title: 'moved nowhere' });
    const before = store.snapshot();
    const write = vi.spyOn(ControlDatabase.prototype, 'write');
    const written = commits; store.updateSession('s', { title: 'only this row' });
    expect(commits).toBe(written + 1);
    const changes = write.mock.calls.at(-1)![0] as ControlChanges; write.mockRestore();
    expect(changes.upserts.map(([table, row]) => [table, row.id])).toEqual([['sessions', 's']]); expect(changes.deletes).toEqual([]);
    expect(before.resources.map(item => item.id)).toEqual(['second', 'third', 'first']);
    store.close(); const reloaded = reopen(owner);
    expect(reloaded.snapshot()).toEqual({ ...before, sessions: [{ ...before.sessions[0]!, title: 'only this row', revision: before.sessions[0]!.revision + 1 }, before.sessions[1]] });
  });
  it('retains process identities but never recreates a PTY or foreground process', async () => {
    const { owner, store } = await open();
    for (const kind of ['pty', 'foreground', 'detached'] as const) store.putResource({ id: kind, session: 's', root: 's', kind, state: 'running', pid: 12345, startIdentity: 'fake-birth', reference: join(owner.target.agentDir, `${kind}.record`), updatedAt: now });
    store.close(); const reloaded = reopen(owner); const plan = reloaded.recover().value;
    expect(plan.reconcileDetached).toEqual(['detached']); expect(plan.missingResources).toEqual(['pty', 'foreground']);
    expect(reloaded.snapshot().resources.map(item => [item.id, item.state, item.pid])).toEqual([['pty', 'missing', 12345], ['foreground', 'missing', 12345], ['detached', 'reconciling', 12345]]);
    expect(() => reloaded.putResource({ ...reloaded.snapshot().resources[0], pid: 999 })).toThrow(/identity/);
  });
  for (const boundary of ['before_commit', 'after_commit'] as PersistenceBoundary[]) {
    it(`fails closed and reloads an atomic snapshot when storage fails at ${boundary}`, async () => {
      let fail = false;
      const { owner, store } = await open({ fault: at => { if (fail && at === boundary) throw Object.assign(new Error('fake ENOSPC'), { code: 'ENOSPC' }); } });
      const initial = store.session('s').revision; fail = true;
      expect(() => store.updateSession('s', { title: 'committed-or-not' })).toThrow(/commit failed/);
      expect(() => store.admit(prompt(), 'owner')).toThrow(/fenced/);
      store.close(); const reloaded = reopen(owner); reloaded.recover();
      expect(reloaded.session('s').title).toBe(boundary === 'after_commit' ? 'committed-or-not' : '');
      expect(reloaded.session('s').revision).toBeGreaterThanOrEqual(initial);
    });
  }
  it('fences local writes after a callback failure even when rollback succeeds', async () => {
    const { store } = await open();
    execControlDatabase(store.directory, "CREATE TRIGGER reject_session_update BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'injected update failure'); END");
    expect(() => store.updateSession('s', { title: 'rejected' })).toThrow(/commit failed/);
    expect(readControlDatabase(store.directory).sessions[0]!.title).toBe('');
    expect(() => store.admit(prompt(), 'owner')).toThrow(/fenced/);
  });
  it('keeps local admission and updates available after a remote callback rolls back', async () => {
    const { store } = await open();
    expect(() => store.database.transaction(() => {
      store.database.putRecord('kind', 'id', 'rolled back');
      throw new Error('remote callback failure');
    })).toThrow('remote callback failure');
    expect(store.database.record('kind', 'id')).toBeUndefined();
    expect(store.admit(prompt(), 'owner').value.phase).toBe('intent');
    store.updateSession('s', { title: 'available' }); expect(store.session('s').title).toBe('available');
  });
  it.each(['remote', 'local'] as const)('fences only local writes when %s BEGIN is busy', async operation => {
    const { store } = await open(); const lock = new DatabaseSync(controlDatabasePath(store.directory)); const callback = vi.fn();
    try {
      lock.exec('BEGIN IMMEDIATE');
      if (operation === 'remote') expect(() => store.database.transaction(callback)).toThrow(expect.objectContaining({ code: 'storage_failure', message: expect.stringMatching(/could not begin/) }));
      else expect(() => store.updateSession('s', { title: 'blocked' })).toThrow(/commit failed/);
      expect(callback).not.toHaveBeenCalled();
    } finally { lock.exec('ROLLBACK'); lock.close(); }
    if (operation === 'local') expect(() => store.admit(prompt(), 'owner')).toThrow(/fenced/);
    else {
      expect(store.admit(prompt(), 'owner').value.phase).toBe('intent');
      store.updateSession('s', { title: 'available' }); expect(store.session('s').title).toBe('available');
    }
  });
  it('discards a rejected commit and writes the next one from the committed state', async () => {
    const { owner, store } = await open(); const revision = store.session('s').revision;
    const valid = vi.spyOn(store as unknown as { validSession(): boolean }, 'validSession').mockReturnValueOnce(false);
    expect(() => store.updateSession('s', { title: 'rejected' })).toThrow(/inconsistent/);
    valid.mockRestore();
    expect(store.session('s')).toMatchObject({ title: '', revision });
    store.updateSession('s', { title: 'accepted' }); store.close();
    expect(reopen(owner).session('s')).toMatchObject({ title: 'accepted', revision: revision + 1 });
  });
  it('quarantines a leftover WAL instead of replaying it into a new database', async () => {
    const { owner, store } = await open(); store.updateSession('s', { title: 'only in the WAL' });
    const path = controlDatabasePath(store.directory); const wal = await readFile(`${path}-wal`);
    store.close(); await rm(path); await writeFile(`${path}-wal`, wal, { mode: 0o600 });
    const reopened = reopen(owner);
    expect(reopened.snapshot().sessions).toEqual([]);
    expect((await readdir(reopened.directory)).some(name => name.startsWith('control-corrupt-') && name.endsWith('.sqlite-wal'))).toBe(true);
  });
  for (const [mode, sql] of [['another schema', 'DROP TABLE requests; CREATE TABLE requests (id TEXT PRIMARY KEY, payload TEXT)'], ['rows without state metadata', "DELETE FROM meta WHERE key IN ('namespace', 'agentDir')"]] as const) {
    it(`quarantines a database with ${mode}`, async () => {
      const { owner, store } = await open(); store.close();
      execControlDatabase(store.directory, sql);
      const reopened = reopen(owner);
      expect(reopened.snapshot().sessions).toEqual([]);
      expect((await readdir(reopened.directory)).some(name => name.startsWith('control-corrupt-'))).toBe(true);
    });
  }
  it('quarantines torn, deleted, unknown-format, foreign or replaced files and starts empty instead of restoring old revisions', async () => {
    for (const mode of ['torn', 'delete', 'version', 'foreign', 'symlink']) {
      const { owner, store } = await open(); store.close(); const path = controlDatabasePath(store.directory);
      if (mode === 'torn') await writeFile(path, 'SQLite format 3\0torn');
      if (mode === 'delete') await rm(path);
      if (mode === 'version') execControlDatabase(store.directory, "UPDATE meta SET value = '3' WHERE key = 'format'");
      if (mode === 'foreign') execControlDatabase(store.directory, "UPDATE meta SET value = '00000000-0000-4000-8000-000000000000' WHERE key = 'storeId'");
      if (mode === 'symlink') { await rename(path, `${path}.old`); await symlink(`${path}.old`, path); }
      const reopened = reopen(owner);
      expect(reopened.snapshot().sessions).toEqual([]); expect(reopened.needsRecovery).toBe(false);
      expect((await readdir(reopened.directory)).some(name => name.startsWith('control-corrupt-'))).toBe(mode !== 'delete');
      reopened.close();
    }
  });
  it('rechecks ownership before writes and after injected scheduling gaps', async () => {
    let replace = false;
    const { owner, store } = await open({ fault: boundary => { if (replace && boundary === 'before_commit') throw new Error('ownership revoked'); } });
    replace = true; expect(() => store.updateSession('s', { title: 'lost' })).toThrow(/commit failed/);
    store.close(); await owner.release(); expect(() => store.snapshot()).toThrow();
  });
});

describe.skipIf(!supported)('shared remote persistence', () => {
  function connect(owner: DaemonOwnership, directory: string, fault?: (boundary: PersistenceBoundary) => void) {
    const database = new ControlDatabase(owner, directory, fault); databases.push(database); return database;
  }
  async function fixture(fault?: (boundary: PersistenceBoundary) => void) {
    const owner = await acquireDaemonOwnership(await target()); owners.push(owner);
    const directory = join(owner.target.agentDir, 'remote-control');
    return { owner, directory, database: connect(owner, directory, fault) };
  }
  it('persists isolated record kinds and paged outbox rows on the same control handle', async () => {
    const { owner, directory, database } = await fixture();
    expect(database.rebuilt).toBe(false);
    expect(database.record('kind', 'missing')).toBeUndefined();
    expect(database.transaction(() => {
      database.putRecord("kind'; DROP TABLE meta; --", 'id', 'opaque');
      database.putRecord('kind', 'id', 'old'); database.putRecord('kind', 'id', 'updated');
      for (const seq of [3, 1, 2]) database.insertOutbox('session', seq, seq * 10, `data-${seq}`);
      database.insertOutbox('other', 7, 70, 'other');
      return 'result';
    })).toBe('result');
    database.write({ meta: { namespace: owner.target.namespaceId, agentDir: owner.target.agentDir, clock: now }, upserts: [], deletes: [] });
    expect(database.read()?.meta.clock).toBe(now);
    expect(database.records('kind')).toEqual([{ id: 'id', data: 'updated' }]);
    expect(database.record("kind'; DROP TABLE meta; --", 'id')).toBe('opaque');
    expect(database.outbox('session', 1, 1)).toEqual([{ seq: 2, bytes: 20, data: 'data-2' }]);
    expect(database.outbox('session', 0, 0)).toEqual([]);
    expect(database.outbox('session').map(row => row.seq)).toEqual([1, 2, 3]);
    database.transaction(() => { database.deleteRecord('kind', 'id'); database.deleteOutbox('session', 2); database.deleteOutbox('other'); });
    database.close();
    const reopened = connect(owner, directory);
    expect(reopened.rebuilt).toBe(false);
    expect(reopened.records('kind')).toEqual([]);
    expect(reopened.record("kind'; DROP TABLE meta; --", 'id')).toBe('opaque');
    expect(reopened.outbox('session')).toEqual([{ seq: 3, bytes: 30, data: 'data-3' }]);
  });
  for (const boundary of ['before_commit', 'after_commit'] as const) {
    it(`atomically fences remote writes at ${boundary}`, async () => {
      let fail = false;
      const { owner, directory, database } = await fixture(at => { if (fail && at === boundary) throw new Error('injected'); });
      database.transaction(() => database.putRecord('kind', 'id', 'before'));
      fail = true;
      expect(() => database.transaction(() => { database.putRecord('kind', 'id', 'after'); database.insertOutbox('session', 1, 4, 'data'); })).toThrow(/commit failed/);
      expect(() => database.record('kind', 'id')).toThrow(/fenced/);
      database.close();
      const reopened = connect(owner, directory);
      expect(reopened.record('kind', 'id')).toBe(boundary === 'before_commit' ? 'before' : 'after');
      expect(reopened.outbox('session')).toHaveLength(boundary === 'before_commit' ? 0 : 1);
    });
  }
  it('requires transactions and rolls back callback failures and duplicate sequences', async () => {
    const { owner, directory, database } = await fixture();
    expect(() => database.putRecord('kind', 'id', 'data')).toThrow(/require a transaction/);
    expect(() => database.deleteRecord('kind', 'id')).toThrow(/require a transaction/);
    expect(() => database.insertOutbox('s', 1, 1, 'x')).toThrow(/require a transaction/);
    expect(() => database.deleteOutbox('s')).toThrow(/require a transaction/);
    expect(() => database.transaction(() => {
      database.putRecord('kind', 'id', 'data');
      database.insertOutbox('s', 1, 1, 'x'); database.insertOutbox('s', 1, 1, 'duplicate');
    })).toThrow(/UNIQUE constraint/);
    expect(database.records('kind')).toEqual([]); expect(database.outbox('s')).toEqual([]);
    expect(() => database.transaction(() => { database.putRecord('kind', 'id', 'data'); throw new Error('callback'); })).toThrow('callback');
    expect(database.records('kind')).toEqual([]);
    database.transaction(() => database.putRecord('kind', 'kept', 'data'));
    database.close();
    const reopened = connect(owner, directory);
    expect(reopened.records('kind')).toEqual([{ id: 'kept', data: 'data' }]); expect(reopened.outbox('s')).toEqual([]);
    reopened.close();
  });
  it('adds remote tables to format 1 without rebuilding control state', async () => {
    const { owner, directory, database } = await fixture();
    database.write({ meta: { namespace: owner.target.namespaceId, agentDir: owner.target.agentDir, clock: now }, upserts: [], deletes: [] });
    database.close();
    execControlDatabase(directory, 'DROP TABLE remote_records; DROP TABLE remote_outbox');
    const reopened = connect(owner, directory);
    expect(reopened.rebuilt).toBe(false); expect(reopened.read()?.meta.clock).toBe(now);
    reopened.transaction(() => reopened.putRecord('kind', 'id', 'data'));
    expect(reopened.record('kind', 'id')).toBe('data');
  });
  for (const mode of ['missing', 'corrupt', 'directory', 'initialization', 'quarantine'] as const) {
    it(`retains the rebuild marker after ${mode} recovery and restart`, async () => {
      const { owner, directory, database } = await fixture();
      database.transaction(() => database.putRecord('kind', 'id', 'data'));
      if (mode === 'quarantine') database.quarantine();
      database.close();
      if (mode === 'missing') await rm(controlDatabasePath(directory));
      if (mode === 'corrupt') await writeFile(controlDatabasePath(directory), 'corrupt');
      if (mode === 'directory') { await rm(directory, { recursive: true }); await writeFile(directory, 'not a directory'); }
      if (mode === 'initialization') await writeFile(join(owner.target.agentDir, `.control-initialized-${createHash('sha256').update(directory).digest('hex')}.json`), 'corrupt');
      const reopened = connect(owner, directory);
      expect(reopened.rebuilt).toBe(true); expect(reopened.records('kind')).toEqual([]);
      reopened.close(); expect(connect(owner, directory).rebuilt).toBe(true);
    });
  }
  it('rejects remote operations after ownership loss', async () => {
    const { owner, database } = await fixture();
    await owner.release();
    expect(() => database.record('kind', 'id')).toThrow();
    expect(() => database.transaction(() => database.putRecord('kind', 'id', 'data'))).toThrow();
  });
  it('retains journal-loss evidence if directory recovery is interrupted before initialization', async () => {
    const { owner, directory, database } = await fixture(); database.close();
    await rename(directory, `${directory}.corrupt-interrupted`);
    await unlink(join(owner.target.agentDir, `.control-initialized-${createHash('sha256').update(directory).digest('hex')}.json`));
    expect(connect(owner, directory).rebuilt).toBe(true);
  });
});

describe.skipIf(!supported)('real crashed-process recovery without execution replay', () => {
  for (const mode of ['intent', 'dispatch', 'effect', 'outcome', 'answer-ready', 'answer-intent', 'answer-effect', 'answer-completed', 'pi-content-first', 'pi-control-first', 'pi-both']) {
    it(`recovers ${mode} from actual SIGKILL persisted files`, async () => {
      const input = await target(); const id = requestId(Date.now());
      const child = spawn(process.execPath, [new URL('./fixtures/persistence-crash.mjs', import.meta.url).pathname, input.directory, input.namespaceId, id, mode], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
      children.push(child);
      let stderr = ''; child.stderr.on('data', bytes => { stderr += String(bytes); });
      const [code, signal] = await once(child, 'exit'); expect({ code, signal, stderr }).toEqual({ code: null, signal: 'SIGKILL', stderr: '' });
      const owner = await acquireDaemonOwnership(input); owners.push(owner);
      const store = new DaemonControlStore(owner); stores.push(store); const before = store.session('session').revision;
      const plan = store.recover().value;
      expect(store.session('session').revision).toBeGreaterThan(before); expect(store.session('session').run.state).toBe('interrupted');
      if (mode.startsWith('answer')) {
        expect(store.snapshot().interactions[0]?.state).toBe('answered');
        expect(store.snapshot().interactions[0]).toMatchObject({ result: { kind: 'input', text: 'yes' } });
        expect(plan.resumableContinuations).toEqual(mode === 'answer-ready' ? ['continuation'] : []);
        expect(store.snapshot().continuations[0]?.phase).toBe(mode === 'answer-ready' ? 'ready' : mode === 'answer-completed' ? 'completed' : 'indeterminate');
      } else if (mode.startsWith('pi-')) {
        const contents = await readFile(join(owner.target.agentDir, 'session.jsonl'), 'utf8');
        store.reconcilePi('session', { present: contents.includes('"entry"') ? [{ id: 'message', entryId: 'entry' }] : [], absentEntryIds: contents.includes('"entry"') ? [] : ['entry'] });
        expect(store.session('session').projections[0]?.value).toMatchObject({ type: 'message', state: mode === 'pi-control-first' ? 'missing' : 'observed' });
      } else expect(store.snapshot().requests[0]?.response?.outcome).toBe(mode === 'intent' ? 'rejected' : mode === 'outcome' ? 'accepted' : 'indeterminate');
      const effects = await readFile(join(owner.target.agentDir, 'effects'), 'utf8').catch(() => '');
      expect(effects.split('\n').filter(Boolean)).toHaveLength(['effect', 'outcome', 'answer-effect'].includes(mode) ? 1 : 0);
    });
  }
});

describe.skipIf(!supported)('atomic interaction winners and continuation intents', () => {
  const answer = { kind: 'input' as const, text: 'yes' };
  function ask(createdAt = now) { return { id: 'ask', scope: { kind: 'session', session: 's', root: 's' }, request: { kind: 'input', title: 'Continue?' }, deferrable: true, state: 'waiting', createdAt }; }
  it('commits one answer, its request outcome, continuation and revision in a single snapshot', async () => {
    const { owner, store } = await open(); store.putInteraction(ask());
    const id = requestId(); store.admit({ v: 1, id, op: 'interaction.answer', session: 's', params: { interactionId: 'ask', answer } }, 'winner');
    const revision = store.session('s').revision;
    const result = store.answerInteraction(id, answer, 'continue');
    expect(result.revisions.s).toBe(revision + 1);
    expect(store.snapshot().requests[0]?.response?.outcome).toBe('accepted');
    expect(store.snapshot().continuations[0]?.phase).toBe('ready');
    const other = requestId(); store.admit({ v: 1, id: other, op: 'interaction.answer', session: 's', params: { interactionId: 'ask', answer } }, 'loser');
    expect(() => store.answerInteraction(other, answer, 'duplicate')).toThrow(/already resolved/);
    store.close(); const reloaded = reopen(owner); expect(reloaded.recover().value.resumableContinuations).toEqual(['continue']);
    expect(reloaded.snapshot().interactions[0]).toMatchObject({ state: 'answered', responder: 'winner', result: answer });
    reloaded.transitionContinuation('continue', 'dispatch_intent');
    expect(() => reloaded.transitionContinuation('continue', 'dispatch_intent')).toThrow(/twice/);
  });
  it('validates admitted answers before committing any winner or revision', async () => {
    const { store } = await open(); store.putInteraction(ask());
    const id = requestId(); store.admit({ v: 1, id, op: 'interaction.answer', session: 's', params: { interactionId: 'ask', answer } }, 'winner');
    const before = store.snapshot();
    expect(() => store.answerInteraction(id, { ...answer, text: 'no' }, 'continue')).toThrow(/differs/);
    expect(store.snapshot()).toEqual(before);
  });
  it('defers ask-user with a bounded default expiry, cancels nonreplayable waits and excludes OAuth secrets', async () => {
    const { owner, store } = await open(); store.putInteraction(ask());
    store.putInteraction({ id: 'approval', scope: { kind: 'session', session: 's', root: 's' }, request: { kind: 'confirm', title: 'Run tool?', message: '' }, state: 'waiting', createdAt: now });
    expect(() => store.putInteraction({ id: 'oauth', scope: { kind: 'host' }, request: { kind: 'oauth', provider: 'fake', url: 'https://invalid/?token=secret', instructions: '', provisioningId: 'fake' }, state: 'waiting', createdAt: now })).toThrow();
    store.close(); const reloaded = reopen(owner); reloaded.recover();
    expect(reloaded.snapshot().interactions[0]).toMatchObject({ state: 'deferred', expiresAt: now + 30 * 60 * 1000 });
    expect(reloaded.snapshot().interactions[1]).toMatchObject({ state: 'cancelled', result: { reason: 'restart' } });
  });
  for (const boundary of ['before_commit', 'after_commit'] as const) it(`preserves all-or-none answer state at ${boundary}`, async () => {
    let fail = false;
    const { owner, store } = await open({ fault: at => { if (fail && at === boundary) throw new Error('disk full'); } });
    store.putInteraction(ask()); const id = requestId(); store.admit({ v: 1, id, op: 'interaction.answer', session: 's', params: { interactionId: 'ask', answer } }, 'winner');
    fail = true; expect(() => store.answerInteraction(id, answer, 'continue')).toThrow(/commit failed/); store.close();
    const reloaded = reopen(owner); const plan = reloaded.recover().value;
    expect(plan.resumableContinuations).toEqual(boundary === 'after_commit' ? ['continue'] : []);
    expect(reloaded.snapshot().interactions[0]?.state).toBe(boundary === 'after_commit' ? 'answered' : 'deferred');
    expect(reloaded.snapshot().requests[0]?.response?.outcome).toBe(boundary === 'after_commit' ? 'accepted' : 'rejected');
  });
});

describe.skipIf(!supported)('control retention and cancellation boundaries', () => {
  it('does not rewrite unchanged resources or renew their transition timestamp for metadata updates', async () => {
    let time = now; const { store } = await open({ now: () => time });
    const resource = store.putResource({ id: 'process', session: 's', root: 's', kind: 'detached', state: 'exited', updatedAt: 0 }).value;
    const revision = store.sessionMetadata('s').revision; const write = vi.spyOn(ControlDatabase.prototype, 'write');
    time += 1000;
    expect(store.putResource({ ...resource, updatedAt: time }).revisions).toEqual({});
    expect(write).not.toHaveBeenCalled(); expect(store.sessionMetadata('s').revision).toBe(revision);
    expect(store.putResource({ ...resource, command: 'restored command', startedAt: now - 100 }).value.updatedAt).toBe(now);
    expect(store.putResource({ ...store.resource('process'), state: 'running' }).value.updatedAt).toBe(time);
    write.mockRestore();
    const copies = store.resources('s'); copies[0]!.state = 'missing';
    expect(store.resource('process')?.state).toBe('running'); expect(store.resources('another-root')).toEqual([]);
  });

  for (const pruning of ['compact', 'admit', 'recover'] as const) it(`bounds terminal resources per root during ${pruning}, retaining unverified evidence and session references`, async () => {
    const { owner, store } = await open();
    store.createSession({ id: 'other', root: 'other', cwd: '/fixture', piPath: join(owner.target.agentDir, 'other.jsonl'), state: 'open', residency: 'warm', run: { state: 'idle' }, policy: { effective: 'host-default', generation: 0 }, title: '' });
    store.close();
    const state = readControlDatabase(store.directory);
    const recent = Array.from({ length: 2200 }, (_, index) => ({ id: `recent-${index}`, session: 's', root: 's', kind: 'detached', state: 'exited', updatedAt: now }));
    const other = Array.from({ length: 1100 }, (_, index) => ({ id: `other-${index}`, session: 'other', root: 'other', kind: 'pty', state: 'exited', updatedAt: now - index }));
    const protectedRows = ['running', 'reconciling', 'missing', 'interrupted'].map(value => ({ id: value, session: 's', root: 's', kind: 'detached', state: value, updatedAt: now - 2 * LIMITS.requestRetentionMs }));
    writeControlDatabase(store.directory, { ...state, resources: [...recent, ...other, ...protectedRows,
      { id: 'expired', session: 's', root: 's', kind: 'foreground', state: 'exited', updatedAt: now - LIMITS.requestRetentionMs - 1 },
      { id: 'boundary', session: 'other', root: 'other', kind: 'foreground', state: 'exited', updatedAt: now - LIMITS.requestRetentionMs },
    ] });
    const reloaded = reopen(owner);
    if (pruning === 'recover') reloaded.recover();
    else {
      reloaded.recover();
      reloaded.putResource({ id: 'overflow', session: 's', root: 's', kind: 'detached', state: 'exited', updatedAt: now });
      if (pruning === 'compact') reloaded.compact(); else reloaded.admit(prompt(), 'owner');
    }
    const rows = reloaded.resources('s');
    expect(rows.filter(row => row.state === 'exited')).toHaveLength(1000);
    expect(rows.filter(row => row.state !== 'exited').map(row => row.id)).toEqual(protectedRows.map(row => row.id));
    expect(reloaded.resource('expired')).toBeUndefined(); expect(reloaded.resource('recent-0')).toBeUndefined();
    expect(reloaded.resource('recent-2199')).toBeDefined(); expect(reloaded.resources('other')).toHaveLength(1000);
    expect(reloaded.snapshot().resources.every(row => reloaded.findSessionMetadata(row.session)?.root === row.root)).toBe(true);
    const revision = reloaded.sessionMetadata('s').revision; const write = vi.spyOn(ControlDatabase.prototype, 'write');
    reloaded.compact(); expect(write).not.toHaveBeenCalled(); expect(reloaded.sessionMetadata('s').revision).toBe(revision); write.mockRestore();
  });

  it('advances revisions when compacting visible projections but never discards revision high-water', async () => {
    let time = now; const { owner, store } = await open({ now: () => time });
    store.project('s', [{ type: 'message', id: 'old', entryId: 'old-entry', state: 'observed' }]);
    const before = store.session('s').revision;
    time += LIMITS.requestRetentionMs + 1; const result = store.compact();
    expect(result.revisions.s).toBe(before + 1); expect(store.session('s').projections).toEqual([]);
    store.close(); const next = reopen(owner, { now: () => time }); next.recover(); expect(next.session('s').revision).toBeGreaterThanOrEqual(before + 1);
    expect(next.session('s').projections).toEqual([]);
  });
  it('persists explicit unsupported/abort/drain outcomes and expires only after the deadline', async () => {
    let time = now; const { store } = await open({ now: () => time });
    const pending = (id: string) => ({ id, scope: { kind: 'session', session: 's', root: 's' }, request: { kind: 'confirm', title: 'Confirm', message: '' }, state: 'waiting', createdAt: now, expiresAt: now + 100 });
    for (const reason of ['unsupported', 'abort', 'drain'] as const) {
      store.putInteraction(pending(reason)); expect(store.cancelInteraction(reason, reason).value).toMatchObject({ state: 'cancelled', result: { reason } });
      expect(() => store.cancelInteraction(reason, 'restart')).toThrow(/resolved/);
    }
    store.putInteraction(pending('expires')); expect(() => store.cancelInteraction('expires', 'timeout')).toThrow(/not expired/);
    time += 100; expect(store.cancelInteraction('expires', 'timeout').value).toMatchObject({ state: 'expired', result: { reason: 'timeout' } });
  });
  it('drops a row whose transcript was substituted by a symlink without quarantining the state', async () => {
    const { owner, store } = await open();
    const other = join(owner.target.agentDir, 'other.jsonl'); await writeFile(other, 'other');
    await symlink(other, join(owner.target.agentDir, 's.jsonl'));
    store.close(); const reopened = reopen(owner);
    expect(reopened.snapshot().sessions).toEqual([]);
    expect((await readdir(reopened.directory)).filter(name => name.startsWith('control-corrupt-'))).toEqual([]);
  });
});

describe.skipIf(!supported)('retained ambiguity', () => {
  it('does not age-evict winning answers or unresolved resource evidence', async () => {
    let time = now; const { owner, store } = await open({ now: () => time });
    store.putInteraction({ id: 'ask', scope: { kind: 'session', session: 's', root: 's' }, request: { kind: 'input', title: 'Continue?' }, deferrable: true, state: 'waiting', createdAt: now });
    const answer = { kind: 'input' as const, text: 'yes' };
    const id = requestId(); store.admit({ v: 1, id, op: 'interaction.answer', session: 's', params: { interactionId: 'ask', answer } }, 'winner');
    store.answerInteraction(id, answer, 'continue'); store.transitionContinuation('continue', 'dispatch_intent');
    store.putResource({ id: 'unresolved', session: 's', root: 's', kind: 'foreground', state: 'running', pid: 1234, startIdentity: 'unknown-outcome', updatedAt: now });
    store.close(); const reloaded = reopen(owner, { now: () => time }); reloaded.recover();
    time += 2 * LIMITS.requestRetentionMs; reloaded.compact();
    expect(reloaded.snapshot().requests).toEqual([]);
    expect(reloaded.snapshot().interactions[0]).toMatchObject({ state: 'answered', result: answer });
    expect(reloaded.snapshot().continuations[0]?.phase).toBe('indeterminate');
    expect(reloaded.snapshot().resources[0]?.id).toBe('unresolved');
  });
});

describe.skipIf(!supported)('reviewed persistence boundaries', () => {
  for (const deletion of ['directory', 'both-files'] as const) it(`rebuilds lost initialized state across owner reacquisition: ${deletion}`, async () => {
    const { owner, store, input } = await open(); const request = prompt();
    store.admit(request, 'owner'); store.markDispatched(request.id);
    store.finishRequest(request.id, { v: 1, re: request.id, outcome: 'accepted', result: { runId: 'done' } });
    store.updateSession('s', { policy: { effective: 'acp-strict', generation: 1 } });
    const revision = store.session('s').revision; expect(revision).toBeGreaterThan(1);
    store.close(); await owner.release();
    if (deletion === 'directory') await rm(store.directory, { recursive: true });
    else await rm(controlDatabasePath(store.directory));
    const nextOwner = await acquireDaemonOwnership(input); owners.push(nextOwner);
    const rebuilt = reopen(nextOwner);
    expect(rebuilt.snapshot().sessions).toEqual([]); expect(rebuilt.needsRecovery).toBe(false);
  });
  it('syncs new control directory entries in their parent and still creates genuinely new stores', async () => {
    const input = await target(); const owner = await acquireDaemonOwnership(input); owners.push(owner);
    const agent = fs.statSync(owner.target.agentDir); const directory = join(owner.target.agentDir, 'new', 'control');
    const syncs: string[] = []; const original = fs.fsyncSync;
    fs.fsyncSync = (fd: number) => {
      const stat = fs.fstatSync(fd);
      if (stat.dev === agent.dev && stat.ino === agent.ino) syncs.push(fs.existsSync(directory) ? 'parent-after-create' : 'initialization-parent');
      return original(fd);
    }; syncBuiltinESMExports();
    try { const store = new DaemonControlStore(owner, { directory }); stores.push(store); expect(store.needsRecovery).toBe(false); }
    finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
    expect(syncs).toContain('initialization-parent'); expect(syncs).toContain('parent-after-create');
    const other = new DaemonControlStore(owner, { directory: join(owner.target.agentDir, 'other-control') }); stores.push(other);
    expect(other.snapshot().requests).toEqual([]);
  });
  it('persists a large valid terminal interaction', async () => {
    const { owner, store } = await open();
    const waiting = { id: 'large', scope: { kind: 'session', session: 's', root: 's' },
      request: { kind: 'form', form: { title: 'Large review', markdown: 'Q'.repeat(128000), fallback: 'Review all content',
        input: { defaults: { first: 'D'.repeat(22000), second: 'D'.repeat(22000) }, fields: [{ id: 'first', kind: 'string', label: 'First', required: true, maxLength: 32768 }, { id: 'second', kind: 'string', label: 'Second', required: true, maxLength: 32768 }] },
        actions: [{ id: 'submit', label: 'Submit', target: 'element', outcome: 'submit' }] } }, deferrable: true, state: 'waiting', createdAt: now };
    const answer = { kind: 'form' as const, actionId: 'submit', outcome: 'submit' as const, values: { first: 'A'.repeat(32000), second: 'A'.repeat(32000) } };
    store.putInteraction(waiting);
    const id = requestId(); store.admit({ v: 1, id, op: 'interaction.answer', session: 's', params: { interactionId: 'large', answer } }, 'winner');
    const result = store.answerInteraction(id, answer, 'continuation'); parseInteraction(result.value);
    expect(result.value.state).toBe('answered'); store.close();
    const reloaded = reopen(owner); reloaded.recover(); expect(reloaded.snapshot().interactions[0]?.state).toBe('answered');
  });
  it('retains rejected outcome diagnostics for retry lookup after reload', async () => {
    const { owner, store } = await open(); const request = prompt();
    store.admit(request, 'owner');
    const response = store.finishRequest(request.id, { v: 1, re: request.id, outcome: 'rejected', error: { code: 'busy', message: 'Session is busy.', retryable: true } }).value;
    expect(response).toMatchObject({ outcome: 'rejected', error: { code: 'busy', message: 'Session is busy.' } });
    store.close(); const reloaded = reopen(owner); reloaded.recover();
    expect(reloaded.admit(request, 'owner').value.response).toEqual(response);
  });
});

describe.skipIf(!supported)('fixed safety session transitions', () => {
  it('validates selectors and lifecycle preconditions without changing any record', async () => {
    const { store } = await open();
    const initial = store.snapshot();
    expect(() => store.transitionSessionForSafety('s', 'running' as never)).toThrow(/Unknown/);
    expect(() => store.transitionSessionForSafety('missing', 'closed')).toThrow(/not found/);
    expect(() => store.transitionSessionForSafety('s', 'cancelling')).toThrow(/existing active/);
    expect(store.snapshot()).toEqual(initial);
    for (const state of ['running', 'waiting', 'cancelling'] as const) {
      store.updateSession('s', { run: { state, id: 'current' } });
      const active = store.snapshot();
      expect(() => store.transitionSessionForSafety('s', 'closed')).toThrow(/Settle/);
      expect(() => store.transitionSessionForSafety('s', 'evicted')).toThrow(/Settle/);
      expect(store.snapshot()).toEqual(active);
    }
    store.updateSession('s', { run: { state: 'running' } });
    expect(() => store.transitionSessionForSafety('s', 'cancelling')).toThrow(/existing active/);
    store.updateSession('s', { run: { state: 'interrupted', id: 'current' } });
    expect(() => store.transitionSessionForSafety('s', 'cancelling')).toThrow(/existing active/);
    store.transitionSessionForSafety('s', 'closed');
    expect(() => store.transitionSessionForSafety('s', 'cancelling')).toThrow(/existing active/);
    expect(store.updateSession('s', { state: 'open' }).value.state).toBe('open');
  });

  it('preserves full records and makes repeated transitions revision-idempotent', async () => {
    const { store, owner } = await open();
    const request = prompt(); store.admit(request, 'owner'); store.markDispatched(request.id);
    store.project('s', [{ type: 'message', id: 'keep', entryId: 'keep-entry', state: 'observed' }]);
    store.putResource({ id: 'detached', session: 's', root: 's', kind: 'detached', state: 'running', reference: join(owner.target.agentDir, 'job.json'), startIdentity: 'birth', updatedAt: now });
    store.updateSession('s', { run: { state: 'running', id: 'current', origin: { kind: 'headless', attachment: 'original' } }, policy: { effective: 'acp-strict', generation: 1 }, title: 'keep title', branch: 'keep branch', model: { provider: 'offline', id: 'test' }, thinking: 'off' });
    for (const transition of ['cancelling', 'idle', 'closed', 'evicted'] as const) {
      const before = store.snapshot(); const old = store.session('s'); const commit = store.transitionSessionForSafety('s', transition);
      const changed = transition !== 'evicted';
      const expected = { ...old, ...(transition === 'closed' ? { state: 'closed', residency: 'evicted' } : {}),
        run: { ...old.run, state: transition === 'cancelling' ? 'cancelling' : transition === 'evicted' ? old.run.state : 'idle' },
        revision: old.revision + (changed ? 1 : 0), updatedAt: now };
      expect(commit.value).toEqual(expected);
      expect(store.snapshot()).toEqual({ ...before, sessions: [expected] });
      const repeated = store.transitionSessionForSafety('s', transition);
      expect(repeated.revisions).toEqual({}); expect(repeated.value).toEqual(commit.value);
    }
  });

  it('requires recovery and current ownership even for an idempotent transition', async () => {
    const { owner, store } = await open(); store.transitionSessionForSafety('s', 'evicted'); store.close();
    const next = reopen(owner);
    expect(() => next.transitionSessionForSafety('s', 'evicted')).toThrow(/Recover/);
    next.recover(); expect(next.transitionSessionForSafety('s', 'evicted').revisions).toEqual({});
    await owner.release(); expect(() => next.transitionSessionForSafety('s', 'evicted')).toThrow();
  });

  for (const boundary of ['before_commit', 'after_commit'] as PersistenceBoundary[]) {
    it(`does not return a safety commit after a fault at ${boundary}`, async () => {
      let fail = false;
      const { owner, store } = await open({ fault: at => { if (fail && at === boundary) throw new Error('injected safety write failure'); } });
      store.updateSession('s', { run: { state: 'running', id: 'original' } });
      const request = prompt(); store.admit(request, 'owner'); store.markDispatched(request.id);
      fail = true;
      expect(() => store.transitionSessionForSafety('s', 'cancelling')).toThrow(/commit failed/);
      expect(() => store.transitionSessionForSafety('s', 'idle')).toThrow(/fenced/);
      store.close(); const next = reopen(owner);
      expect(next.session('s').run.state).toBe(boundary === 'after_commit' ? 'cancelling' : 'running');
      next.recover(); expect(next.session('s').run).toMatchObject({ state: 'interrupted', id: 'original' });
      expect(next.snapshot().requests[0]?.response?.outcome).toBe('indeterminate');
    });
  }
});

describe.skipIf(!supported)('control file recovery', () => {
  const corrupt = async (directory: string) => (await readdir(directory)).filter(name => name.startsWith('control-corrupt-'));

  it('starts empty without quarantine when the control file is missing', async () => {
    const { owner, store } = await open(); const directory = store.directory; store.close();
    await unlink(controlDatabasePath(directory));
    expect(reopen(owner).snapshot().sessions).toEqual([]);
    expect(await corrupt(directory)).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)('fails retryably without quarantine when the control file cannot be read', async () => {
    const { owner, store } = await open(); const directory = store.directory; const path = controlDatabasePath(directory); store.close();
    const before = await readFile(path); await chmod(path, 0o000);
    try { expect(() => reopen(owner)).toThrow(expect.objectContaining({ code: 'storage_failure', message: expect.stringContaining('EACCES') })); }
    finally { await chmod(path, 0o600); }
    expect(await readFile(path)).toEqual(before);
    expect(await corrupt(directory)).toEqual([]);
  });

  it('keeps a row whose session directory is outside the current roots and owns that directory again', async () => {
    const { owner, store, input } = await open(); const directory = store.directory; store.close();
    const custom = join(await realpath(input.directory), 'custom-sessions'); await mkdir(custom);
    const piPath = join(custom, 's.jsonl');
    const state = readControlDatabase(directory);
    state.sessions[0]!.piPath = piPath;
    writeControlDatabase(directory, state);
    expect(() => owner.assertOwnsPath(piPath)).toThrow(/outside/);
    const reopened = reopen(owner);
    expect(reopened.snapshot().sessions.map(session => session.piPath)).toEqual([piPath]);
    await reopened.ownPersistedRoots();
    expect(owner.assertOwnsPath(piPath)).toBe(piPath);
    expect(reopened.snapshot().sessions.map(session => session.piPath)).toEqual([piPath]);
    expect(await corrupt(directory)).toEqual([]);
  });
});
