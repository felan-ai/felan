import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireDaemonOwnership, type DaemonOwnership } from '../src/daemon/ownership.js';
import { DaemonControlStore } from '../src/daemon/control-store.js';
import type { SessionRegistry } from '../src/daemon/registry.js';
import { createRegistrySessionsService } from '../src/daemon/session-services.js';
import { randomUUID } from 'node:crypto';

const now = 1_800_000_000_000;
const roots: string[] = [];
const owners: DaemonOwnership[] = [];
const stores: DaemonControlStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const owner of owners.splice(0)) await owner.release();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function openStore() {
  const directory = await mkdtemp(join(tmpdir(), 'dca-')); roots.push(directory);
  const owner = await acquireDaemonOwnership({ kind: 'isolated', directory, namespaceId: randomUUID() }); owners.push(owner);
  const store = new DaemonControlStore(owner, { now: () => now }); stores.push(store);
  store.createSession({ id: 's', root: 's', cwd: '/fixture', piPath: join(owner.target.agentDir, 's.jsonl'), state: 'open', residency: 'warm', run: { state: 'idle' }, policy: { effective: 'host-default', generation: 0 }, title: 'first' });
  return { owner, store, directory };
}

describe('daemon control store access', () => {
  it('returns session metadata without projections and copies that cannot mutate the store', async () => {
    const { store } = await openStore();
    const metadata = store.sessionMetadata('s');
    expect(metadata).not.toHaveProperty('projections');
    expect(metadata).toMatchObject({ id: 's', title: 'first' });
    (metadata as { title: string }).title = 'mutated';
    expect(store.session('s').title).toBe('first');
    expect(store.sessionMetadatas().map(item => item.id)).toEqual(['s']);
  });

  it('returns resource and request copies and reports absent identities as undefined', async () => {
    const { store } = await openStore();
    expect(store.resource('missing')).toBeUndefined();
    expect(store.request('missing')).toBeUndefined();
    expect(store.resources()).toEqual([]);
  });

  it('refuses access after the ownership has been lost', async () => {
    const { owner, store } = await openStore();
    await owner.release();
    expect(() => store.sessionMetadata('s')).toThrow();
    expect(() => store.request('missing')).toThrow();
    expect(() => store.assertCurrent()).toThrow();
  });
});

async function transcriptDirectory(owner: DaemonOwnership): Promise<string> {
  const directory = join(owner.target.agentDir, 'sessions'); await mkdir(directory, { recursive: true }); return directory;
}

function sessionsFixture(rows: Array<{ id: string; piPath: string; updatedAt: number }>, owner: DaemonOwnership) {
  const current = { id: 'current', root: 'current' };
  const access = vi.fn();
  const stored = (id: string) => ({ id, root: id, cwd: '/project', piPath: rows.find(row => row.id === id)?.piPath ?? join(owner.target.agentDir, `${id}.jsonl`), title: id, updatedAt: rows.find(row => row.id === id)?.updatedAt ?? 0, state: 'closed' as const, revision: 0, residency: 'evicted' as const, run: { state: 'idle' as const }, policy: { effective: 'host-default' as const, generation: 0 }, projections: [] });
  const registry = { assertServiceAccess: access, options: { owner, store: { sessionMetadata: stored } }, list: () => [{ ...stored('current') }, ...rows.map(row => stored(row.id))],
    subscribe: () => () => {} } as unknown as SessionRegistry;
  return { access, service: createRegistrySessionsService(registry, current, '/project') };
}

describe('registry sessions service', () => {
  it('checks access a bounded number of times when reading a transcript larger than one copy chunk', async () => {
    const { owner } = await openStore();
    const id = 'long';
    const path = join(await transcriptDirectory(owner), 'long.jsonl');
    const lines = [JSON.stringify({ type: 'session', version: 3, id, cwd: '/project', timestamp: '2026-08-24T10:00:00.000Z' })];
    let parent: string | null = null;
    for (let index = 0; index < 1500; index++) {
      const entryId = `e${index}`;
      lines.push(JSON.stringify({ type: 'message', id: entryId, parentId: parent, timestamp: '2026-08-24T10:00:00.000Z',
        message: { role: 'user', content: 'x'.repeat(1000), timestamp: 0 } }));
      parent = entryId;
    }
    await writeFile(path, lines.join('\n') + '\n');
    const { access, service } = sessionsFixture([{ id, piPath: path, updatedAt: 1 }], owner);
    const page = await service.history(id);
    expect(page.entries).toHaveLength(256);
    expect(access.mock.calls.length).toBeLessThan(10);
  });

  it('reports the newer of the control row and transcript modification times as the update time', async () => {
    const { owner } = await openStore();
    const directory = await transcriptDirectory(owner);
    const older = join(directory, 'older.jsonl'); const newer = join(directory, 'newer.jsonl');
    const header = (id: string) => JSON.stringify({ type: 'session', version: 3, id, cwd: '/project', timestamp: '2026-08-24T10:00:00.000Z' }) + '\n';
    await writeFile(older, header('older')); await writeFile(newer, header('newer'));
    const modified = new Date(now - 60_000);
    await utimes(older, modified, modified); await utimes(newer, modified, modified);
    const { service } = sessionsFixture([
      { id: 'older', piPath: older, updatedAt: now - 3_600_000 },
      { id: 'newer', piPath: newer, updatedAt: now + 5_000 },
    ], owner);
    const listed = await service.list({ scope: 'visible' }, {});
    const byId = new Map(listed.items.map(item => [item.id, item.updatedAt]));
    expect(byId.get('older')).toBe(Math.floor(modified.getTime()));
    expect(byId.get('newer')).toBe(now + 5_000);
  });
});
