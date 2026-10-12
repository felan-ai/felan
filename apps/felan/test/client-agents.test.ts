import { afterEach, expect, it, vi } from 'vitest';
import type { LocalSubagentNavigatorHost } from '../../daemon/src/subagents/presentation.js';
import type { LocalSubagentView } from '../../daemon/src/subagents/host.js';
import { serverFixture, gate } from '../../daemon/test/fixtures/server.js';
import { SessionServer } from '../../daemon/src/daemon/server.js';
import { DaemonConfiguration } from '../../daemon/src/daemon/configuration.js';
import { SessionClient, newRequestId } from '../src/client/client.js';
import { ClientAgentHost } from '../src/client/agent-host.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const settings = () => ({ hideThinking: false, showImages: false, imageWidthCells: 60, outputPad: 1, toolMode: 'grouped' as const });

async function fixture(capacity?: { requests: number; reserveRequests: number }) {
  const release = gate(); const entered = gate(); let blocked = false;
  const f = await serverFixture({ now: Date.now, ...(capacity ? { capacity } : {}), onStream: async () => { if (blocked) { entered.resolve(); await release.promise; } } });
  let server: SessionServer | undefined; const clients: SessionClient[] = []; const views: ClientAgentHost[] = [];
  cleanups.push(async () => { release.resolve(); for (const view of views) await view.dispose(); clients.forEach(client => client.close()); server?.close(); await f.dispose(); });
  const child = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, rootSessionId: f.root.sessionId, parentSessionId: f.root.sessionId });
  await child.runtime.session.prompt('child-history'); f.registry.projection(child.sessionId).refresh();
  let rows: LocalSubagentView[] = [{ agentId: 'child-one', parentSessionId: f.root.sessionId, rootSessionId: f.root.sessionId,
    type: 'general', description: 'First child', status: 'running', createdAt: new Date(0).toISOString(), sessionId: child.sessionId, session: child.runtime.session },
  { agentId: 'child-two', parentSessionId: f.root.sessionId, rootSessionId: f.root.sessionId, type: 'general', description: 'Second child', status: 'completed', createdAt: new Date(1).toISOString(), result: 'retained result' }];
  const listeners = new Set<() => void>(); const changed = () => { for (const listener of listeners) listener(); };
  const host: LocalSubagentNavigatorHost = {
    listLocalSubagents: () => rows, getLocalSubagent: id => rows.find(row => row.agentId === id),
    subscribe(callback) { const listener = () => callback(rows); listeners.add(listener); listener(); return () => { listeners.delete(listener); }; },
    steer: vi.fn(async id => ({ ok: true as const, value: rows.find(row => row.agentId === id)! })),
    cancel: vi.fn(async id => {
      rows = rows.map(row => row.agentId === id ? { ...row, status: 'cancelled' as const, completedAt: new Date().toISOString() } : row);
      changed(); return { ok: true as const, value: rows.find(row => row.agentId === id)! };
    }),
  };
  f.registry.bindSubagentView(f.root.sessionId, host);
  server = new SessionServer({ registry: f.registry, models: f.root.runtime.session.modelRuntime, version: 'fixture',
    configuration: new DaemonConfiguration({ agentDir: f.owner.target.agentDir, definitions: [], assertCurrent: () => f.registry.assertAdmission() }) });
  await server.start();
  async function client(kind: 'tui' | 'headless' = 'tui') {
    const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
      expected: f.owner.identity, clientVersion: 'fixture', kind, retries: 0 });
    clients.push(client); await client.connect(); await client.attach(f.root.sessionId); return client;
  }
  return { ...f, child, host, client, views, entered, release, block() { blocked = true; }, setRows(next: LocalSubagentView[]) { rows = next; changed(); } };
}

it('paginates scoped records, reads retained results and streams the real child into the data-only host', async () => {
  const f = await fixture(); const client = await f.client();
  expect(client.capabilities?.operations).toEqual(expect.arrayContaining(['agents.list', 'agents.read', 'agents.steer', 'agents.cancel']));
  const first = await client.request('agents.list', { limit: 1 }, { session: f.root.sessionId });
  if (first.outcome !== 'accepted' || !first.result.cursor) throw new Error('Missing first page');
  const second = await client.request('agents.list', { cursor: first.result.cursor, limit: 1 }, { session: f.root.sessionId });
  expect(second).toMatchObject({ outcome: 'accepted', result: { generation: first.result.generation, entries: [{ agentId: 'child-two' }] } });
  expect(JSON.stringify(first)).not.toContain('sessionManager');
  expect(await client.request('agents.read', { agentId: 'child-two' }, { session: f.root.sessionId })).toMatchObject({ outcome: 'accepted', result: { result: 'retained result' } });
  const view = new ClientAgentHost(client, f.root.sessionId, settings); f.views.push(view);
  await view.refresh(); view.selectAgent('child-one');
  await vi.waitFor(() => expect(view.getLocalSubagent('child-one')?.projection?.messages.some(message => message.role === 'user'
    && JSON.stringify(message.content).includes('child-history'))).toBe(true));
  const projection = view.getLocalSubagent('child-one')!.projection!;
  expect(projection.messages.find(message => message.role === 'assistant')).toMatchObject({ provider: 'offline', model: 'fixture' });
  expect(view.getLocalSubagent('child-one')).not.toHaveProperty('session');
  await view.dispose();
  expect(client.getAttachment(f.child.sessionId)).toBeUndefined();
  expect(client.getAttachment(f.root.sessionId)).toBeDefined();
});

it('steers and cancels once while the parent model is active, without starting another parent turn', async () => {
  const f = await fixture(); const a = await f.client(); const b = await f.client(); f.block();
  await a.request('prompt', { text: 'hold parent' }, { session: f.root.sessionId }); await f.entered.promise;
  const before = f.root.runtime.session.messages.length;
  expect(await a.request('agents.steer', { agentId: 'child-one', message: 'Focus on tests' }, { session: f.root.sessionId }))
    .toMatchObject({ outcome: 'accepted', result: { ok: true } });
  expect(f.host.steer).toHaveBeenCalledWith('child-one', 'Focus on tests');
  const id = newRequestId();
  const outcomes = await Promise.all([a, b].map(client => client.request('agents.cancel', { agentId: 'child-one' }, { session: f.root.sessionId, id })));
  expect(outcomes[0]).toEqual(outcomes[1]); expect(outcomes[0]).toMatchObject({ outcome: 'accepted', result: { ok: true, agent: { status: 'cancelled' } } });
  expect(f.host.cancel).toHaveBeenCalledTimes(1);
  expect(f.root.runtime.session.messages.length).toBe(before);
  expect(f.root.runtime.session.isIdle).toBe(false);
  expect(await a.request('agents.cancel', { agentId: 'unrelated' }, { session: f.root.sessionId })).toMatchObject({ outcome: 'rejected', error: { code: 'not_found' } });
  expect(f.host.cancel).toHaveBeenCalledTimes(1); f.release.resolve();
});

it('invalidates a paged catalog after a record change and excludes headless control clients', async () => {
  const f = await fixture(); const client = await f.client(); const headless = await f.client('headless');
  expect(headless.capabilities?.operations).not.toContain('agents.cancel');
  const page = await client.request('agents.list', { limit: 1 }, { session: f.root.sessionId });
  if (page.outcome !== 'accepted' || !page.result.cursor) throw new Error('Missing cursor');
  const current = f.host.listLocalSubagents(); f.setRows(current.map(row => ({ ...row, description: 'updated' })));
  expect(await client.request('agents.list', { cursor: page.result.cursor, limit: 1 }, { session: f.root.sessionId })).toMatchObject({ outcome: 'rejected', error: { code: 'resync_required' } });
  const view = new ClientAgentHost(client, f.root.sessionId, settings); f.views.push(view); await view.refresh();
  f.setRows(current.map(row => ({ ...row, description: 'new value' })));
  await vi.waitFor(() => expect(view.getLocalSubagent('child-one')?.description).toBe('new value'));
});

it('admits cancellation through the reserved request slot when ordinary admissions are full', async () => {
  const f = await fixture({ requests: 3, reserveRequests: 1 }); const client = await f.client();
  for (let index = 0; index < 2; index++) f.store.admit({ v: 1, id: newRequestId(), op: 'prompt', session: f.root.sessionId, params: { text: `held-${index}` } }, 'fixture');
  expect(await client.request('agents.steer', { agentId: 'child-one', message: 'no room' }, { session: f.root.sessionId }))
    .toMatchObject({ outcome: 'rejected', error: { code: 'request_capacity' } });
  expect(f.host.steer).not.toHaveBeenCalled();
  expect(await client.request('agents.cancel', { agentId: 'child-one' }, { session: f.root.sessionId }))
    .toMatchObject({ outcome: 'accepted', result: { ok: true, agent: { status: 'cancelled' } } });
  expect(f.host.cancel).toHaveBeenCalledOnce();
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
