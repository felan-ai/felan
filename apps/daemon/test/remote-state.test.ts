import { randomUUID } from 'node:crypto';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteStorageError, RemoteStore } from '../src/remote/state.js';
import { closeRemoteDatabases, openRemoteDatabase } from './remote-database.js';

const record = { shared: true, origin: 'local' as const, backfilled: false, unsharedPending: false };
afterEach(async () => { vi.restoreAllMocks(); await closeRemoteDatabases(); });

describe('remote state', () => {
  it('loads records and missing records once, caches the id list, and returns isolated copies', async () => {
    const { database } = await openRemoteDatabase(); const first = randomUUID(); const missing = randomUUID();
    new RemoteStore(database).setSession(first, record);
    const store = new RemoteStore(database); const read = vi.spyOn(database, 'record'); const rows = vi.spyOn(database, 'records');
    expect(store.session(first)).toEqual(record); expect(store.session(missing)).toBeUndefined(); expect(store.sessions()).toEqual([first]);
    for (let index = 0; index < 10; index++) {
      const copy = store.session(first)!; copy.shared = false;
      expect(store.session(missing)).toBeUndefined(); store.sessions().pop();
    }
    expect(store.session(first)).toEqual(record); expect(store.sessions()).toEqual([first]);
    expect(read).toHaveBeenCalledTimes(2); expect(rows).toHaveBeenCalledTimes(1);
    const input = { ...record }; const result = store.setSession(missing, input); input.shared = false; result.shared = false;
    expect(store.session(missing)).toEqual(record); expect(store.sessions().sort()).toEqual([first, missing].sort());
    expect(read).toHaveBeenCalledTimes(2); expect(rows).toHaveBeenCalledTimes(1);
  });
  it('checks database ownership for every cached read and list', async () => {
    const { database } = await openRemoteDatabase(); const store = new RemoteStore(database); const id = randomUUID();
    store.setSession(id, record); store.session(id); store.sessions();
    const check = vi.spyOn(database, 'assertCurrent'); check.mockClear();
    store.settings(); store.session(id); store.sessions(); expect(check).toHaveBeenCalledTimes(3);
    check.mockImplementation(() => { throw new Error('ownership lost'); });
    expect(() => store.settings()).toThrow(RemoteStorageError);
    expect(() => store.session(id)).toThrow(RemoteStorageError);
    expect(() => store.sessions()).toThrow(RemoteStorageError);
  });
  it('removes session rows and cached records without leaving tombstones', async () => {
    const { database } = await openRemoteDatabase(); const store = new RemoteStore(database); const id = randomUUID(); const other = randomUUID();
    store.setSession(id, record); store.setSession(other, record); expect(store.sessions().sort()).toEqual([id, other].sort());
    store.removeSession(id); store.removeSession(id);
    expect(store.session(id)).toBeUndefined(); expect(store.sessions()).toEqual([other]);
    expect(new RemoteStore(database).session(id)).toBeUndefined(); expect(database.records('session').map(row => row.id)).toEqual([other]);
    store.setSession(id, record); expect(store.session(id)).toEqual(record);
    expect(() => store.removeSession('../escape')).toThrow(/UUID/u);
  });
  it('persists an optional skipped-change count and rejects invalid counts before writing', async () => {
    const { database } = await openRemoteDatabase(); const id = randomUUID(); const store = new RemoteStore(database);
    store.setSession(id, { ...record, skippedChanges: 0 }); expect(new RemoteStore(database).session(id)?.skippedChanges).toBe(0);
    store.setSession(id, { ...record, skippedChanges: 2 }); expect(new RemoteStore(database).session(id)?.skippedChanges).toBe(2);
    for (const skippedChanges of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) expect(() => store.setSession(id, { ...record, skippedChanges })).toThrow();
    expect(store.session(id)?.skippedChanges).toBe(2);
  });
  it('persists defaults, install identity, settings and session records in the shared database', async () => {
    const { database, owner } = await openRemoteDatabase(); const root = owner.target.agentDir; const store = new RemoteStore(database);
    expect(store.settings()).toMatchObject({ share: 'on-request', projects: [] });
    expect(store.settings().installId).toMatch(/^[a-f0-9-]{36}$/u);
    const project = store.addProject(root, 'Fixture'); const session = randomUUID();
    store.configure({ share: 'all', apiUrl: 'https://example.test' }); store.setSession(session, record);
    const reopened = new RemoteStore(database);
    expect(reopened.settings()).toEqual(store.settings()); expect(reopened.settings().projects).toEqual([project]);
    expect(reopened.session(session)).toEqual(record); expect(reopened.sessions()).toEqual([session]);
    const copy = reopened.settings(); copy.projects[0]!.name = 'mutated'; expect(reopened.settings().projects[0]!.name).toBe('Fixture');
  });
  it('canonicalizes paths and reuses a stable project id through symlink aliases', async () => {
    const { database, owner } = await openRemoteDatabase(); const root = owner.target.agentDir; const real = join(root, 'project'); mkdirSync(real); const alias = join(root, 'alias'); symlinkSync(real, alias);
    const store = new RemoteStore(database); const a = store.addProject(real); const b = store.addProject(alias);
    expect(a).toEqual(b); expect(a.path).toBe(real); expect(store.settings().projects).toHaveLength(1);
    store.removeProject(a.id); expect(store.settings().projects).toEqual([]);
  });
  it('rejects invalid settings, duplicate projects, relative paths and excessive projects', async () => {
    const { database, owner } = await openRemoteDatabase(); const root = owner.target.agentDir; const store = new RemoteStore(database); const project = store.addProject(root);
    expect(() => store.configure({ projects: [project, { ...project, id: randomUUID() }] })).toThrow();
    expect(() => store.configure({ projects: [project, { ...project, path: join(root, 'different') }] })).toThrow();
    expect(() => store.addProject('../escape')).toThrow();
    expect(() => store.configure({ projects: Array.from({ length: 257 }, () => project) })).toThrow();
    for (const apiUrl of ['file:///tmp/foo', 'https://user:password@example.test', 'https://example.test?token=hidden']) expect(() => store.configure({ apiUrl })).toThrow();
    expect(store.settings().projects).toEqual([project]);
  });
  for (const bytes of ['{"torn":', JSON.stringify({ version: 1, settings: { installId: randomUUID(), share: 'invalid', projects: [] } }), JSON.stringify({ version: 1, settings: { installId: randomUUID(), share: 'all', projects: [], unexpected: true } })]) {
    it('atomically quarantines invalid settings instead of accepting or overwriting them', async () => {
      const { database } = await openRemoteDatabase(); new RemoteStore(database);
      database.transaction(() => database.putRecord('settings', 'settings', bytes));
      const store = new RemoteStore(database); expect(store.settings().share).toBe('on-request');
      expect(database.records('quarantine')).toEqual([{ id: expect.stringMatching(/^settings:settings:/u), data: bytes }]);
      expect(database.record('settings', 'settings')).not.toBe(bytes);
    });
  }
  it('quarantines only an invalid session record and validates ids before I/O', async () => {
    const { database } = await openRemoteDatabase(); const id = randomUUID(); new RemoteStore(database).setSession(id, record);
    database.transaction(() => database.putRecord('session', id, '{"version":99}'));
    const store = new RemoteStore(database); expect(store.sessions()).toEqual([id]);
    expect(store.session(id)).toBeUndefined(); expect(store.settings().installId).toBe(new RemoteStore(database).settings().installId);
    expect(store.sessions()).toEqual([]); expect(database.record('session', id)).toBeUndefined();
    expect(database.records('quarantine')).toEqual([{ id: expect.stringContaining(`session:${id}:`), data: '{"version":99}' }]);
    for (const invalid of ['../outside', '', '/tmp/a', `${id}/../../x`]) {
      expect(() => store.setSession(invalid, record)).toThrow(/UUID/u); expect(() => store.session(invalid)).toThrow(/UUID/u);
    }
  });
  it('does not quarantine records on database read failures', async () => {
    const { database } = await openRemoteDatabase(); const id = randomUUID(); const store = new RemoteStore(database); store.setSession(id, record);
    const reopened = new RemoteStore(database);
    vi.spyOn(database, 'record').mockImplementationOnce(() => { throw new Error('read failed'); });
    expect(() => reopened.session(id)).toThrow(RemoteStorageError);
    expect(database.records('quarantine')).toEqual([]); expect(reopened.session(id)).toEqual(record);
  });
  it.each(['before_commit', 'after_commit'] as const)('fences cached reads after a failed commit at %s and reopens atomically', async boundary => {
    let fail = false;
    const { database, reopen } = await openRemoteDatabase(at => { if (fail && at === boundary) throw new Error('injected'); });
    const store = new RemoteStore(database); const id = randomUUID(); store.setSession(id, record); store.sessions(); fail = true;
    expect(() => store.setSession(id, { ...record, shared: false })).toThrow(RemoteStorageError);
    expect(() => store.settings()).toThrow(RemoteStorageError);
    expect(() => store.session(id)).toThrow(RemoteStorageError);
    expect(() => store.sessions()).toThrow(RemoteStorageError);
    expect(new RemoteStore(reopen()).session(id)?.shared).toBe(boundary === 'before_commit');
  });
  it.each(['before_commit', 'after_commit'] as const)('moves a corrupt session into quarantine atomically at %s', async boundary => {
    let fail = false;
    const { database, reopen } = await openRemoteDatabase(at => { if (fail && at === boundary) throw new Error('injected'); });
    const store = new RemoteStore(database); const id = randomUUID();
    database.transaction(() => database.putRecord('session', id, '{invalid')); fail = true;
    expect(() => store.session(id)).toThrow(RemoteStorageError);
    const recovered = reopen();
    expect(recovered.record('session', id)).toBe(boundary === 'before_commit' ? '{invalid' : undefined);
    expect(recovered.records('quarantine')).toHaveLength(boundary === 'before_commit' ? 0 : 1);
    if (boundary === 'after_commit') expect(recovered.records('quarantine')[0]?.data).toBe('{invalid');
  });
  it('does not update caches when a transaction fails', async () => {
    const { database } = await openRemoteDatabase(); const store = new RemoteStore(database); const id = randomUUID();
    store.setSession(id, record); store.sessions();
    const before = database.record('settings', 'settings');
    vi.spyOn(database, 'transaction').mockImplementation(() => { throw new Error('commit failed'); });
    expect(() => store.configure({ share: 'all' })).toThrow(RemoteStorageError);
    expect(() => store.setSession(id, { ...record, shared: false })).toThrow(RemoteStorageError);
    expect(() => store.removeSession(id)).toThrow(RemoteStorageError);
    expect(store.settings().share).toBe('on-request'); expect(store.session(id)).toEqual(record); expect(store.sessions()).toEqual([id]);
    expect(database.record('settings', 'settings')).toBe(before);
  });
});
