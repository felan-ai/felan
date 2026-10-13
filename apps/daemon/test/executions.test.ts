import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createRegistrySessionsService } from '../src/daemon/session-services.js';
import { recoverControlState } from '../src/daemon/control-recovery.js';
import { DaemonControlStore } from '../src/daemon/control-store.js';
import { fixture, fixtures, realFixture, deferred } from './fixtures/registry.js';
import type { ExecutionHost, ExecutionCompletionNotice } from '../src/daemon/executions.js';

const request = (description = 'task') => ({ prompt: description, description, label: 'general', model: { provider: 'offline', id: 'fixture' } });
afterEach(async () => { for (const cleanup of fixtures.splice(0)) await cleanup(); });
async function completed(host: ExecutionHost, id: string) {
  await vi.waitFor(() => expect(host.getExecution(id)?.status).toBe('completed'));
  await host.settle();
}

describe('registry-owned executions', () => {
  it('registers queued children before dispatch, caps concurrency and cancels a queue entry without running it', async () => {
    const gate = deferred(); let calls = 0;
    const f = await realFixture(async () => { calls++; if (calls === 1) await gate.promise; });
    f.releases.add(gate.resolve);
    const host = f.registry.executionHost(f.root.sessionId); host.configure({ concurrency: 1 });
    const first = await host.spawnSession(request('first'));
    if (!first.ok) throw new Error(first.error.message);
    await vi.waitFor(() => expect(calls).toBe(1));
    const second = await host.spawnSession(request('queued'));
    if (!second.ok) throw new Error(second.error.message);
    expect(second.value.status).toBe('queued');
    expect(f.store.session(second.value.executionId)).toMatchObject({ parent: f.root.sessionId, execution: { request: { description: 'queued' } } });
    expect(host.listExecutions()).toHaveLength(2);
    await expect(host.cancel(second.value.executionId)).resolves.toMatchObject({ ok: true, value: { status: 'cancelled' } });
    gate.resolve(); await completed(host, first.value.executionId);
    expect(calls).toBe(1);
    await expect(readFile(join(f.owner.target.agentDir, 'executions', f.root.sessionId, 'records.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('derives results and usage from the same child transcript and continues with one canonical identity', async () => {
    const f = await realFixture(); const host = f.registry.executionHost(f.root.sessionId);
    const child = await host.spawnSession(request()); if (!child.ok) throw new Error(child.error.message);
    await completed(host, child.value.executionId);
    const row = f.store.session(child.value.executionId);
    expect(row.execution).not.toHaveProperty('result'); expect(row.execution).not.toHaveProperty('usage');
    expect(host.getExecution(row.id)).toMatchObject({ result: 'done', usage: { input: 1, output: 1 } });
    expect(await host.steer(row.id, 'continue')).toMatchObject({ ok: true });
    await completed(host, row.id);
    expect(f.store.session(row.id).piPath).toBe(row.piPath);
    expect(host.getExecution(row.id)).toMatchObject({ result: 'done', usage: { input: 2, output: 2 } });
    expect(f.registry.list().filter(item => item.parent === f.root.sessionId)).toHaveLength(1);
  });

  it('scopes controls to direct children, limits depth and cancels descendants as one tree', async () => {
    const gate = deferred(); let calls = 0;
    const f = await realFixture(async () => { calls++; await gate.promise; }); f.releases.add(gate.resolve);
    const host = f.registry.executionHost(f.root.sessionId); host.configure({ concurrency: 2, maxDepth: 2 });
    const child = await host.spawnSession(request('child')); if (!child.ok) throw new Error(child.error.message);
    const nested = host.scopeToSession(child.value.executionId);
    const grandchild = await nested.spawnSession(request('grandchild')); if (!grandchild.ok) throw new Error(grandchild.error.message);
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(await host.getResult(grandchild.value.executionId)).toMatchObject({ ok: false });
    expect(await nested.scopeToSession(grandchild.value.executionId).spawnSession(request('too deep'))).toMatchObject({ ok: false, error: { code: 'depth_exceeded' } });
    expect(host.listExecutions(true)).toHaveLength(2);
    const cancel = host.cancel(child.value.executionId); gate.resolve(); await cancel;
    expect(host.listExecutions(true).map(row => row.status)).toEqual(['cancelled', 'cancelled']);
    expect(await nested.spawnSession(request('after cancellation'))).toMatchObject({ ok: false, error: { code: 'parent_unavailable' } });
  });

  it('retains completion delivery in canonical state until acknowledged, with non-consuming reads', async () => {
    const f = await realFixture(); const host = f.registry.executionHost(f.root.sessionId);
    const notices: ExecutionCompletionNotice[] = [];
    let delivered = false;
    host.attachParent({ deliverCompletion: async notice => { notices.push(notice); return delivered ? 'delivered' : 'queued'; } });
    const child = await host.spawnSession({ ...request(), notifyOnCompletion: true }); if (!child.ok) throw new Error(child.error.message);
    await completed(host, child.value.executionId);
    expect(notices).toHaveLength(1);
    expect(f.store.session(child.value.executionId).execution?.completionPending).toBe(true);
    await host.getResult(child.value.executionId); await host.getResult(child.value.executionId);
    expect(host.hasPendingWork()).toBe(true);
    delivered = true;
    await vi.waitFor(() => expect(host.getExecution(child.value.executionId)?.completionPending).toBe(false));
    expect(host.hasPendingWork()).toBe(false);
    await host.steer(child.value.executionId, 'again'); await completed(host, child.value.executionId);
    expect(notices.at(-1)?.deliveryId).not.toBe(notices[0]?.deliveryId);
    expect(notices.at(-1)?.summary).toBe('done');
  });

  it('steers queued and running children without starting another execution', async () => {
    const gate = deferred(); let calls = 0;
    const f = await realFixture(async () => { calls++; if (calls === 1) await gate.promise; }); f.releases.add(gate.resolve);
    const host = f.registry.executionHost(f.root.sessionId); host.configure({ concurrency: 1 });
    const first = await host.spawnSession(request('first')); if (!first.ok) throw new Error(first.error.message);
    await vi.waitFor(() => expect(calls).toBe(1));
    const steer = vi.spyOn(f.registry.binding(first.value.executionId)!.runtime.session, 'steer');
    expect(await host.steer(first.value.executionId, 'running guidance')).toMatchObject({ ok: true });
    expect(steer).toHaveBeenCalledWith('running guidance');
    const second = await host.spawnSession(request('second')); if (!second.ok) throw new Error(second.error.message);
    expect(await host.steer(second.value.executionId, 'queued guidance')).toMatchObject({ ok: true });
    gate.resolve(); await completed(host, second.value.executionId);
    expect(JSON.stringify(f.registry.binding(second.value.executionId)!.runtime.session.messages)).toContain('queued guidance');
    expect(host.listExecutions()).toHaveLength(2);
  });

  it('retains timeout diagnostics and joins cancellation before releasing the execution', async () => {
    const gate = deferred();
    const f = await realFixture(async () => gate.promise); f.releases.add(gate.resolve);
    const host = f.registry.executionHost(f.root.sessionId);
    const child = await host.spawnSession({ ...request(), timeoutMs: 10 }); if (!child.ok) throw new Error(child.error.message);
    await vi.waitFor(() => expect(host.getExecution(child.value.executionId)?.status).toBe('timed_out'));
    expect(host.hasActiveJobs()).toBe(true);
    gate.resolve(); await host.settle();
    expect(host.hasActiveJobs()).toBe(false);
    expect(await host.steer(child.value.executionId, 'retry')).toMatchObject({ ok: false, error: { code: 'not_steerable' } });
  });

  it('acknowledges a completion without consuming ordinary result reads', async () => {
    const f = await realFixture(); const host = f.registry.executionHost(f.root.sessionId);
    const child = await host.spawnSession({ ...request(), notifyOnCompletion: true }); if (!child.ok) throw new Error(child.error.message);
    await completed(host, child.value.executionId);
    await host.getResult(child.value.executionId);
    expect(host.getExecution(child.value.executionId)?.completionPending).toBe(true);
    await host.getResult(child.value.executionId, { acknowledge: true });
    expect(host.getExecution(child.value.executionId)?.completionPending).toBe(false);
  });

  it('rejects unavailable models and child admission disabled by the parent', async () => {
    const gate = deferred();
    const f = await realFixture(async () => gate.promise); f.releases.add(gate.resolve);
    const host = f.registry.executionHost(f.root.sessionId);
    expect(await host.spawnSession({ ...request(), model: { provider: 'missing', id: 'model' } })).toMatchObject({ ok: false, error: { code: 'unsupported_model' } });
    expect(host.listExecutions()).toEqual([]);
    const child = await host.spawnSession({ ...request(), allowChildren: false }); if (!child.ok) throw new Error(child.error.message);
    expect(await host.scopeToSession(child.value.executionId).spawnSession(request())).toMatchObject({ ok: false, error: { code: 'depth_exceeded' } });
    gate.resolve(); await completed(host, child.value.executionId);
  });

  it('does not requeue a retained child when its parent closes during continuation', async () => {
    const f = await realFixture(); const host = f.registry.executionHost(f.root.sessionId);
    const child = await host.spawnSession(request()); if (!child.ok) throw new Error(child.error.message);
    await completed(host, child.value.executionId);
    const entered = deferred(); const gate = deferred(); f.releases.add(gate.resolve);
    const restore = f.registry.restore.bind(f.registry);
    vi.spyOn(f.registry, 'restore').mockImplementation(async (id, context) => {
      const binding = await restore(id, context);
      if (id === child.value.executionId) { entered.resolve(); await gate.promise; }
      return binding;
    });
    const continuation = host.steer(child.value.executionId, 'continue');
    await entered.promise;
    const closing = f.registry.close(f.root.sessionId);
    gate.resolve();
    expect(await continuation).toMatchObject({ ok: false });
    await closing;
    expect(f.store.session(child.value.executionId).execution?.outcome).toBe('completed');
  });

  it('blocks idle eviction while a registered child is queued', async () => {
    const f = await fixture(); const root = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, parentSessionId: root.sessionId, rootSessionId: root.sessionId,
      execution: { request: request(), createdAt: new Date().toISOString(), deliveryId: 'delivery', completionPending: false } });
    expect(await f.registry.evictIdle()).toEqual([]);
    await f.registry.close(root.sessionId);
    expect(f.store.snapshot().sessions.every(row => row.state === 'closed')).toBe(true);
  });

  it('reports interrupted queued and running work on recovery without replaying either', async () => {
    const f = await fixture(); const root = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    for (const startedAt of [undefined, new Date().toISOString()]) await f.registry.create({ cwd: f.cwd, target: { kind: 'new' },
      parentSessionId: root.sessionId, rootSessionId: root.sessionId,
      execution: { request: { ...request(), notifyOnCompletion: true }, createdAt: new Date().toISOString(), deliveryId: String(startedAt),
        completionPending: false, ...(startedAt ? { startedAt } : {}) } });
    const state = f.store.snapshot(); recoverControlState(state, Date.now());
    expect(state.sessions.filter(row => row.parent).map(row => row.execution)).toEqual([
      expect.objectContaining({ outcome: 'cancelled', completionPending: true, error: { code: 'host_shutdown', message: expect.stringContaining('restart') } }),
      expect.objectContaining({ outcome: 'cancelled', completionPending: true, error: { code: 'host_shutdown', message: expect.stringContaining('restart') } }),
    ]);
  });

  it('reads completed children after reopening the daemon control store without restoring their runtimes', async () => {
    const f = await fixture(); const root = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const child = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, parentSessionId: root.sessionId, rootSessionId: root.sessionId,
      execution: { request: request(), createdAt: new Date().toISOString(), deliveryId: 'delivery', completionPending: false,
        completedAt: new Date(Date.now() + 10_000).toISOString(), outcome: 'completed' } });
    await child.runtime.session.prompt('work'); await f.registry.shutdown(); f.store.close();
    const store = new DaemonControlStore(f.owner); const registry = f.createRegistry(store); f.replaceRegistry(registry, store);
    const host = registry.executionHost(root.sessionId);
    expect(registry.binding(child.sessionId)).toBeUndefined();
    expect(host.getExecution(child.sessionId)).toMatchObject({ status: 'completed', result: 'done', usage: { input: 1, output: 1 } });
    expect(registry.binding(child.sessionId)).toBeUndefined();
    await rm(store.session(child.sessionId).piPath);
    expect(host.getExecution(child.sessionId)).not.toHaveProperty('usage');
  });

  it('exposes canonical results through felan.sessions and publishes live usage invalidations', async () => {
    const f = await realFixture();
    const sessions = createRegistrySessionsService(f.registry, { id: f.root.sessionId, root: f.root.sessionId }, f.cwd);
    const events = vi.fn(); const stop = sessions.subscribe(events);
    const child = await sessions.create(request());
    await completed(f.registry.executionHost(f.root.sessionId), child.id);
    expect((await sessions.executions()).items).toContainEqual(expect.objectContaining({ id: child.id, session: { id: child.id, parent: f.root.sessionId, root: f.root.sessionId }, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cost: 0 }, result: { text: 'done', truncated: false } }));
    expect(events).toHaveBeenCalledWith({ kind: 'execution', id: child.id });
    stop();
  });
});
