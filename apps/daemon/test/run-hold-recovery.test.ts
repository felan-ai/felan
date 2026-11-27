import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { recoverControlState } from '../src/daemon/control-recovery.js';
import { DaemonControlStore } from '../src/daemon/control-store.js';
import type { ContinueRecord } from '../src/daemon/run-hold.js';
import { fixture, fixtures } from './fixtures/registry.js';

afterEach(async () => { for (const cleanup of fixtures.splice(0)) await cleanup(); });
const request = { prompt: 'child task', description: 'child task', label: 'general', model: { provider: 'offline', id: 'fixture' } };

/** A root and a started child execution, both with a running run, as a held daemon leaves them. */
async function heldTree() {
  const f = await fixture();
  const root = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
  const child = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, parentSessionId: root.sessionId, rootSessionId: root.sessionId,
    execution: { request, createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), deliveryId: 'delivery', completionPending: false } });
  for (const [id, run] of [[root.sessionId, 'root-run'], [child.sessionId, 'child-run']] as const) f.store.updateSession(id, { run: { state: 'running', id: run } });
  const record = (session: string, run: string, parent?: string): ContinueRecord => ({ version: 1, session, root: root.sessionId, ...(parent ? { parent } : {}),
    run: { id: run }, leaf: 'leaf', heldAt: 1, queue: [] });
  return { f, root: root.sessionId, child: child.sessionId, records: [record(child.sessionId, 'child-run', root.sessionId), record(root.sessionId, 'root-run')] };
}

describe('recovery of held runs', () => {
  it('keeps held runs running and their child execution unfinished, and continues parents before children', async () => {
    const { f, root, child, records } = await heldTree();
    const state = f.store.snapshot();
    const plan = recoverControlState(state, Date.now(), records);
    expect(plan.continueRuns.map(record => record.session)).toEqual([root, child]);
    const rows = new Map(state.sessions.map(row => [row.id, row]));
    expect(rows.get(root)).toMatchObject({ residency: 'evicted', run: { state: 'running', id: 'root-run' } });
    expect(rows.get(child)).toMatchObject({ residency: 'evicted', run: { state: 'running', id: 'child-run' } });
    expect(rows.get(child)!.execution).not.toHaveProperty('completedAt');
  });

  it.each([
    ['names another run', (records: ContinueRecord[]) => [{ ...records[1]!, run: { id: 'other-run' } }]],
    ['names another root', (records: ContinueRecord[]) => [{ ...records[1]!, root: records[0]!.session }]],
    ['describes no registered session', (records: ContinueRecord[]) => [{ ...records[1]!, session: 'missing' }]],
  ])('interrupts a run whose record %s, as it does without a record', async (_label, change) => {
    const { f, root, records } = await heldTree();
    const state = f.store.snapshot();
    const plan = recoverControlState(state, Date.now(), change(records));
    expect(plan.continueRuns).toEqual([]);
    expect(state.sessions.find(row => row.id === root)!.run).toMatchObject({ state: 'interrupted', id: 'root-run' });
  });

  it('cancels a child execution that already completed or never started instead of continuing it', async () => {
    const { f, child, records } = await heldTree();
    const { startedAt: _started, ...queued } = f.store.sessionMetadata(child).execution!;
    f.store.updateSession(child, { execution: queued });
    const state = f.store.snapshot();
    expect(recoverControlState(state, Date.now(), records).continueRuns.map(record => record.session)).not.toContain(child);
    expect(state.sessions.find(row => row.id === child)!.execution).toMatchObject({ outcome: 'cancelled', error: { code: 'host_shutdown' } });
  });

  it('stores continue records in their own table, skips one it cannot read and clears them all', async () => {
    const { f, root, records } = await heldTree();
    f.store.putHeldRuns(records);
    expect(f.store.heldRuns().map(record => record.session).sort()).toEqual(records.map(record => record.session).sort());
    const path = join(f.store.directory, 'control.sqlite');
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(path);
    try { db.prepare('UPDATE held_runs SET data = ? WHERE session = ?').run(JSON.stringify({ ...records[1], version: 2 }), root); }
    finally { db.close(); }
    expect(f.store.heldRuns().map(record => record.session)).toEqual([records[0]!.session]);
    f.store.clearHeldRuns();
    expect(f.store.heldRuns()).toEqual([]);
  });

  it('creates the record table in a store written before it existed', async () => {
    const f = await fixture();
    await f.registry.shutdown(); f.store.close();
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(join(f.store.directory, 'control.sqlite'));
    try { db.exec('DROP TABLE held_runs'); } finally { db.close(); }
    const store = new DaemonControlStore(f.owner);
    f.replaceRegistry(f.createRegistry(store), store);
    expect(store.heldRuns()).toEqual([]);
  });
});

describe('continuing held runs after a restart', () => {
  it('interrupts a held run whose transcript changed after it was held, and consumes its record', async () => {
    const f = await fixture();
    const root = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    await root.runtime.session.prompt('start');
    const manager = root.runtime.session.sessionManager;
    const record: ContinueRecord = { version: 1, session: root.sessionId, root: root.sessionId, run: { id: 'held-run' }, leaf: manager.getLeafId()!, heldAt: 1, queue: [] };
    const path = manager.getSessionFile()!;
    await f.registry.shutdown();
    // What a held daemon's stop leaves behind: an evicted session whose run is still running, and its record.
    f.store.updateSession(root.sessionId, { residency: 'evicted', run: { state: 'running', id: 'held-run' } });
    f.store.putHeldRuns([record]);
    f.store.close();
    await appendFile(path, `${JSON.stringify({ type: 'custom', customType: 'later', data: {}, id: 'late0001', parentId: record.leaf, timestamp: new Date().toISOString() })}\n`);
    const store = new DaemonControlStore(f.owner);
    const registry = f.createRegistry(store); f.replaceRegistry(registry, store);
    expect(store.sessionMetadata(root.sessionId).run).toMatchObject({ id: 'held-run', state: 'running' });
    expect(store.heldRuns()).toEqual([]);
    await registry.restoreRecovered();
    expect(store.sessionMetadata(root.sessionId).run).toMatchObject({ id: 'held-run', state: 'interrupted' });
    expect(() => registry.assertRunAvailable(root.sessionId)).not.toThrow();
  });
});

describe('a held root run that fails to continue', () => {
  it('ends interrupted rather than idle', async () => {
    const f = await fixture();
    const root = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    await root.runtime.session.prompt('start');
    const record: ContinueRecord = { version: 1, session: root.sessionId, root: root.sessionId, run: { id: 'held-run' },
      leaf: root.runtime.session.sessionManager.getLeafId()!, heldAt: 1, queue: [] };
    await f.registry.shutdown();
    f.store.updateSession(root.sessionId, { residency: 'evicted', run: { state: 'running', id: 'held-run' } });
    f.store.putHeldRuns([record]);
    f.store.close();
    const store = new DaemonControlStore(f.owner);
    const registry = f.createRegistry(store); f.replaceRegistry(registry, store);
    // The fixture session cannot start a step, so the continued run fails with an error that is not an abort.
    await registry.restoreRecovered();
    await vi.waitFor(() => expect(store.sessionMetadata(root.sessionId).run.state).not.toBe('running'));
    expect(store.sessionMetadata(root.sessionId).run).toMatchObject({ id: 'held-run', state: 'interrupted' });
  });
});

describe('a held child that cannot continue', () => {
  it('finishes its execution as cancelled by the restart, so its parent is still told', async () => {
    const f = await fixture();
    const root = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const now = new Date().toISOString();
    const execution = { request: { ...request, notifyOnCompletion: true }, createdAt: now, startedAt: now, deliveryId: 'delivery', completionPending: false };
    const child = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, parentSessionId: root.sessionId, rootSessionId: root.sessionId, execution });
    await f.registry.shutdown();
    // What a held daemon's stop leaves behind; the record's leaf no longer matches the child's transcript.
    f.store.updateSession(child.sessionId, { residency: 'evicted', run: { state: 'running', id: 'child-run' }, execution });
    f.store.putHeldRuns([{ version: 1, session: child.sessionId, root: root.sessionId, parent: root.sessionId, run: { id: 'child-run' }, leaf: 'gone', heldAt: 1, queue: [] }]);
    f.store.close();
    const store = new DaemonControlStore(f.owner);
    const registry = f.createRegistry(store); f.replaceRegistry(registry, store);
    expect(store.sessionMetadata(child.sessionId).execution).not.toHaveProperty('completedAt');
    await registry.restoreRecovered();
    expect(store.sessionMetadata(child.sessionId)).toMatchObject({ run: { state: 'interrupted', id: 'child-run' },
      execution: { outcome: 'cancelled', error: { code: 'host_shutdown' }, completionPending: true } });
  });
});

describe('restoring after a restart', () => {
  it('reports restoring until the held runs have been continued or interrupted', async () => {
    const f = await fixture();
    expect(f.registry.restoring).toBe(false);
    const root = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    await root.runtime.session.prompt('start');
    const record: ContinueRecord = { version: 1, session: root.sessionId, root: root.sessionId, run: { id: 'held-run' },
      leaf: root.runtime.session.sessionManager.getLeafId()!, heldAt: 1, queue: [] };
    await f.registry.shutdown();
    f.store.updateSession(root.sessionId, { residency: 'evicted', run: { state: 'running', id: 'held-run' } });
    f.store.putHeldRuns([record]);
    f.store.close();
    const store = new DaemonControlStore(f.owner);
    const registry = f.createRegistry(store); f.replaceRegistry(registry, store);
    expect(registry.restoring).toBe(true);
    await registry.restoreRecovered();
    expect(registry.restoring).toBe(false);
  });
});
