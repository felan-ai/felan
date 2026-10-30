import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireDaemonOwnership, type DaemonOwnership } from '../src/daemon/ownership.js';
import { DaemonControlStore } from '../src/daemon/control-store.js';
import { readControlDatabase, writeControlDatabase } from './fixtures/control-database.js';

const supported = ['darwin', 'linux'].includes(process.platform);
const roots: string[] = [];
const owners: DaemonOwnership[] = [];
const stores: DaemonControlStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const owner of owners.splice(0)) await owner.release();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function open() {
  const directory = await mkdtemp(join(tmpdir(), 'act-')); roots.push(directory);
  const owner = await acquireDaemonOwnership({ kind: 'isolated', directory, namespaceId: randomUUID() }); owners.push(owner);
  const clock = { now: 1_000 };
  const store = new DaemonControlStore(owner, { now: () => clock.now }); stores.push(store);
  const create = (id: string, parent?: string) => store.createSession({ id, root: parent ? 'root' : id, ...(parent ? { parent } : {}), cwd: '/fixture',
    piPath: join(owner.target.agentDir, `${id}.jsonl`), state: 'open', residency: 'warm', run: { state: 'idle' }, policy: { effective: 'host-default', generation: 0 }, title: '' });
  return { owner, store, clock, create };
}

describe.skipIf(!supported)('session activity', () => {
  it('moves only for new runs and observed messages, carrying ancestors without changing their revision', async () => {
    const { owner, store, clock, create } = await open();
    create('root');
    clock.now = 2_000; create('child', 'root'); create('grandchild', 'child');
    const activity = () => ['root', 'child', 'grandchild'].map(id => store.sessionMetadata(id).activityAt);
    expect(activity()).toEqual([2_000, 2_000, 2_000]);
    const rootRevision = store.sessionMetadata('root').revision;

    clock.now = 3_000;
    store.updateSession('grandchild', { residency: 'evicted' }); store.updateSession('grandchild', { title: 'renamed' });
    expect(store.sessionMetadata('grandchild').updatedAt).toBe(3_000); expect(activity()).toEqual([2_000, 2_000, 2_000]);

    clock.now = 4_000; store.updateSession('grandchild', { run: { state: 'running', id: 'run-1' } });
    expect(activity()).toEqual([4_000, 4_000, 4_000]);
    clock.now = 5_000;
    store.updateSession('grandchild', { run: { state: 'waiting', id: 'run-1' } }); store.updateSession('grandchild', { run: { state: 'running', id: 'run-1' } });
    store.transitionSessionForSafety('grandchild', 'cancelling'); store.transitionSessionForSafety('grandchild', 'idle');
    expect(activity()).toEqual([4_000, 4_000, 4_000]);

    clock.now = 6_000; store.project('child', [{ type: 'message', id: 'm1', entryId: 'e1', state: 'observed' }]);
    expect(activity()).toEqual([4_000, 4_000, 4_000]);
    store.project('child', [{ type: 'message', id: 'm2', entryId: 'e2', state: 'observed' }], true);
    expect(activity()).toEqual([6_000, 6_000, 4_000]);
    expect(store.sessionMetadata('root').revision).toBe(rootRevision);

    store.close(); stores.splice(stores.indexOf(store), 1);
    const reopened = new DaemonControlStore(owner, { now: () => clock.now }); stores.push(reopened);
    expect(['root', 'child', 'grandchild'].map(id => reopened.sessionMetadata(id).activityAt)).toEqual([6_000, 6_000, 4_000]);
    expect(reopened.sessionMetadata('root').revision).toBe(rootRevision);
  });

  it('rejects a self-parented session instead of following its lineage forever', async () => {
    const { create } = await open();
    create('root');
    expect(() => create('loop', 'loop')).toThrow();
  });

  it('starts adopted transcripts and rows from before activity tracking at the transcript write time', async () => {
    const { owner, store, clock, create } = await open();
    const written = (id: string) => join(owner.target.agentDir, `${id}.jsonl`);
    await writeFile(written('root'), '{}\n'); await utimes(written('root'), 0.5, 0.5);
    clock.now = 9_000; create('root');
    expect(store.sessionMetadata('root').activityAt).toBe(500);
    create('child', 'root'); create('missing', 'root');
    store.updateSession('child', { run: { state: 'running', id: 'run' } }); store.transitionSessionForSafety('child', 'idle');
    store.close(); stores.splice(stores.indexOf(store), 1);

    const persisted = readControlDatabase(store.directory);
    writeControlDatabase(store.directory, { ...persisted, sessions: persisted.sessions.map(({ activityAt: _activityAt, ...row }) => ({ ...row, updatedAt: 20_000 })) });
    await writeFile(written('child'), '{}\n'); await utimes(written('child'), 1.5, 1.5);
    const reopened = new DaemonControlStore(owner, { now: () => 30_000 }); stores.push(reopened);
    // The missing transcript falls back to the row's last change; the root is raised to its latest descendant.
    expect(['root', 'child', 'missing'].map(id => reopened.sessionMetadata(id).activityAt)).toEqual([20_000, 1_500, 20_000]);
  });
});
