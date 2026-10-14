import { randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { ExecutionHost, ExecutionRecord } from '@felan-ai/daemon/provider';
import { serverFixture, gate } from '../../daemon/test/fixtures/server.js';
import { SessionServer } from '../../daemon/src/daemon/server.js';
import { DaemonConfiguration } from '../src/providers/configuration.js';
import { SessionClient, newRequestId } from '../src/client/client.js';
import { ClientAgentHost } from '../src/client/agent-host.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const settings = () => ({ hideThinking: false, showImages: false, imageWidthCells: 60, outputPad: 1, toolMode: 'grouped' as const });

async function fixture() {
  const release = gate(); const entered = gate(); let blocked = false;
  const f = await serverFixture({ now: Date.now, onStream: async () => { if (blocked) { entered.resolve(); await release.promise; } } });

  let server: SessionServer | undefined; const clients: SessionClient[] = []; const views: ClientAgentHost[] = [];
  let releaseAgentView = () => {};
  cleanups.push(async () => { release.resolve(); releaseAgentView(); for (const view of views) await view.dispose(); clients.forEach(client => client.close()); server?.close(); await f.dispose(); });
  const rootLease = await f.registry.attach(f.root.sessionId, { principal: 'fixture', kind: 'tui' });
  cleanups.push(async () => { f.registry.detach(f.root.sessionId, rootLease.attachment); });
  const child = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, model: f.root.runtime.session.model!, rootSessionId: f.root.sessionId, parentSessionId: f.root.sessionId });

  await child.runtime.session.prompt('child-history'); f.registry.projection(child.sessionId).refresh();
  let rows: ExecutionRecord[] = [{ executionId: 'child-one', parentSessionId: f.root.sessionId, rootSessionId: f.root.sessionId,
    label: 'general', description: 'First child', status: 'running', createdAt: new Date(0).toISOString(), sessionId: child.sessionId, session: child.runtime.session },
  { executionId: 'child-two', parentSessionId: f.root.sessionId, rootSessionId: f.root.sessionId, label: 'general', description: 'Second child', status: 'completed', createdAt: new Date(1).toISOString(), result: 'retained result' }];

  const listeners = new Set<() => void>(); const changed = () => { for (const listener of listeners) listener(); f.registry.projection(f.root.sessionId).setExecutionsGeneration(randomBytes(32).toString('hex')); };
  const host = {
    subscribeUsage: () => () => {},
    listExecutions: () => rows,
    getResult: async (id: string) => ({ ok: true as const, value: rows.find(row => row.executionId === id)! }), getExecution: (id: string) => rows.find(row => row.executionId === id),
    subscribe(callback: (rows: readonly ExecutionRecord[]) => void) { const listener = () => callback(rows); listeners.add(listener); listener(); return () => { listeners.delete(listener); }; },
    steer: vi.fn(async (id: string) => ({ ok: true as const, value: rows.find(row => row.executionId === id)! })),
    cancel: vi.fn(async (id: string) => {
      rows = rows.map(row => row.executionId === id ? { ...row, status: 'cancelled' as const, completedAt: new Date().toISOString() } : row);
      changed(); return { ok: true as const, value: rows.find(row => row.executionId === id)! };
    }),
  };
  const original = f.registry.executionHost.bind(f.registry);
  const hostSpy = vi.spyOn(f.registry, 'executionHost').mockImplementation(id => id === f.root.sessionId ? host as unknown as ExecutionHost : original(id));
  releaseAgentView = () => hostSpy.mockRestore();

  server = new SessionServer({ registry: f.registry, models: f.root.runtime.session.modelRuntime, version: 'fixture',
    configuration: new DaemonConfiguration({ agentDir: f.owner.target.agentDir, definitions: [], assertCurrent: () => f.registry.assertAdmission() }) });

  await server.start();
  async function client(kind: 'tui' | 'acp' | 'headless' = 'tui') {
    const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
      expected: f.owner.identity, clientVersion: 'fixture', kind, retries: 0 });
    clients.push(client); await client.connect(); await client.attach(f.root.sessionId); return client;
  }
  return { ...f, child, host, client, views, entered, release, block() { blocked = true; }, setRows(next: ExecutionRecord[]) { rows = next; changed(); } };
}

it('paginates scoped records, reads retained results and streams the real child into the data-only host', async () => {
  const f = await fixture(); const client = await f.client();
  expect(client.capabilities?.operations).toEqual(expect.arrayContaining(['executions.list', 'executions.read', 'executions.steer', 'executions.cancel']));
  const first = await client.request('executions.list', { limit: 1 }, { session: f.root.sessionId });

  if (first.outcome !== 'accepted' || !first.result.nextCursor) throw new Error('Missing first page');
  const second = await client.request('executions.list', { cursor: first.result.nextCursor, limit: 1 }, { session: f.root.sessionId });
  expect(second).toMatchObject({ outcome: 'accepted', result: { items: [{ id: 'child-two' }] } });
  expect(JSON.stringify(first)).not.toContain('sessionManager');
  expect(await client.request('executions.read', { executionId: 'child-two' }, { session: f.root.sessionId })).toMatchObject({ outcome: 'accepted', result: { result: { text: 'retained result' } } });
  const view = new ClientAgentHost(client, f.root.sessionId, settings); f.views.push(view);
  await view.refresh(); view.selectAgent('child-one');
  await vi.waitFor(() => expect(view.getLocalSubagent('child-one')?.projection?.messages.some(message => message.role === 'user'
    && JSON.stringify(message.content).includes('child-history'))).toBe(true));
  const projection = view.getLocalSubagent('child-one')!.projection!;
  expect(projection.messages.find(message => message.role === 'assistant')).toMatchObject({ provider: 'offline', model: 'fixture' });
  expect(view.getLocalSubagent('child-one')).not.toHaveProperty('liveSession');
  await view.dispose();
  expect(client.getAttachment(f.child.sessionId)).toBeUndefined();
  expect(client.getAttachment(f.root.sessionId)).toBeDefined();
});

it.each(['tui', 'acp'] as const)('reads an ordinary child session from %s without a custom presenter or agent navigator', async kind => {
  const f = await fixture(); const client = await f.client(kind);
  expect(client.capabilities).not.toHaveProperty('presenters');
  const record = await client.request('executions.read', { executionId: 'child-one' }, { session: f.root.sessionId });
  expect(record).toMatchObject({ outcome: 'accepted', result: { session: { id: f.child.sessionId } } });
  expect((await client.attach(f.child.sessionId)).outcome).toBe('accepted');
  const snapshot = client.getAttachment(f.child.sessionId)?.state.snapshot;
  expect(JSON.stringify(snapshot?.history.entries)).toContain('child-history');
  expect(snapshot?.history.entries.some(entry => entry.role === 'assistant')).toBe(true);
  await client.detach(f.child.sessionId);
  expect(client.getAttachment(f.child.sessionId)).toBeUndefined();
  expect(client.getAttachment(f.root.sessionId)).toBeDefined();
  expect(f.registry.binding(f.child.sessionId)?.runtime).toBe(f.child.runtime);
  expect(f.store.session(f.child.sessionId).state).toBe('open');
});

it('steers and cancels once while the parent model is active, without starting another parent turn', async () => {
  const f = await fixture(); const a = await f.client(); const b = await f.client(); f.block();
  await a.request('prompt', { text: 'hold parent' }, { session: f.root.sessionId }); await f.entered.promise;
  const before = f.root.runtime.session.messages.length;
  expect(await a.request('executions.steer', { executionId: 'child-one', message: 'Focus on tests' }, { session: f.root.sessionId }))
    .toMatchObject({ outcome: 'accepted', result: { state: 'running' } });
  expect(f.host.steer).toHaveBeenCalledWith('child-one', 'Focus on tests');
  const id = newRequestId();
  const outcomes = await Promise.all([a, b].map(client => client.request('executions.cancel', { executionId: 'child-one' }, { session: f.root.sessionId, id })));
  expect(outcomes[0]).toEqual(outcomes[1]); expect(outcomes[0]).toMatchObject({ outcome: 'accepted', result: { state: 'cancelled' } });
  expect(f.host.cancel).toHaveBeenCalledTimes(1);
  expect(f.root.runtime.session.messages.length).toBe(before);
  expect(f.root.runtime.session.isIdle).toBe(false);
  expect(await a.request('executions.cancel', { executionId: 'unrelated' }, { session: f.root.sessionId })).toMatchObject({ outcome: 'rejected', error: { code: 'forbidden' } });
  expect(f.host.cancel).toHaveBeenCalledTimes(1); f.release.resolve();
});

it('invalidates a paged catalog after a record change and admits attached headless controls', async () => {
  const f = await fixture(); const client = await f.client(); const headless = await f.client('headless');
  expect(headless.capabilities?.operations).toContain('executions.cancel');
  expect(await headless.request('executions.steer', { executionId: 'child-one', message: 'Inspect the updated catalog' }, { session: f.root.sessionId }))
    .toMatchObject({ outcome: 'accepted', result: { state: 'running' } });
  expect(f.host.steer).toHaveBeenCalledWith('child-one', 'Inspect the updated catalog');
  const page = await client.request('executions.list', { limit: 1 }, { session: f.root.sessionId });
  if (page.outcome !== 'accepted' || !page.result.nextCursor) throw new Error('Missing cursor');
  const current = f.host.listExecutions(); f.setRows(current.map(row => ({ ...row, description: 'updated' })));
  expect(await client.request('executions.list', { cursor: page.result.nextCursor, limit: 1 }, { session: f.root.sessionId })).toMatchObject({ outcome: 'rejected', error: { code: 'resync_required' } });
  const view = new ClientAgentHost(client, f.root.sessionId, settings); f.views.push(view); await view.refresh();
  f.setRows(current.map(row => ({ ...row, description: 'new value' })));
  await vi.waitFor(() => expect(view.getLocalSubagent('child-one')?.description).toBe('new value'));
});

it('joins a late child attachment during disposal without stopping the child runtime', async () => {
  const f = await fixture(); const client = await f.client(); const attached = gate(); const release = gate();
  const original = f.registry.attach.bind(f.registry);
  const spy = vi.spyOn(f.registry, 'attach').mockImplementation(async (id, metadata) => {
    const result = await original(id, metadata);
    if (id === f.child.sessionId) { attached.resolve(); await release.promise; }
    return result;
  });
  const view = new ClientAgentHost(client, f.root.sessionId, settings); f.views.push(view);
  try {
    await view.refresh(); await attached.promise;
    let finished = false; const disposing = view.dispose().then(() => { finished = true; });
    await Promise.resolve(); expect(finished).toBe(false);
    release.resolve(); await disposing;
    expect(client.getAttachment(f.child.sessionId)).toBeUndefined();
    expect(f.registry.attachmentCount(f.child.sessionId)).toBe(0);
    expect(f.registry.binding(f.child.sessionId)).toBeDefined();
    expect(f.host.cancel).not.toHaveBeenCalled();
  } finally { release.resolve(); spy.mockRestore(); }
});

it('does not detach a child attachment borrowed from another client component', async () => {
  const f = await fixture(); const client = await f.client(); await client.attach(f.child.sessionId);
  const identity = client.getAttachment(f.child.sessionId)!.id;
  const view = new ClientAgentHost(client, f.root.sessionId, settings); f.views.push(view); await view.refresh();
  await view.dispose();
  expect(client.getAttachment(f.child.sessionId)?.id).toBe(identity);
  expect(f.registry.attachmentCount(f.child.sessionId)).toBe(1);
});

it('surfaces a failed view observer without interrupting other observers or protocol processing', async () => {
  const f = await fixture(); const client = await f.client();
  const view = new ClientAgentHost(client, f.root.sessionId, settings); f.views.push(view);
  const remove = view.subscribe(() => { throw new Error('renderer failed'); }); const healthy = vi.fn(); view.subscribe(healthy);
  await view.refresh();
  expect(healthy).toHaveBeenCalled(); expect(view.getStatus()).toBe('renderer failed');
  expect(client.status).toBe('ready'); remove();
});
