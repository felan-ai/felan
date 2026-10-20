import { afterEach, expect, it, vi } from 'vitest';
import type { Execution } from '@felan-ai/session-protocol';
import { ClientAgentHost } from '../src/client/agent-host.js';
import { snapshot } from './client-fixtures.js';
import { deferred } from './generic-extension-ui-fixtures.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const row = (description: string): Execution => ({ id: 'child', parent: 'session', label: 'general', description, state: 'completed', createdAt: new Date(0).toISOString() });
type Reply = { outcome: 'accepted'; result: { items: Execution[]; nextCursor?: string } };
const reply = (description: string): Reply => ({ outcome: 'accepted', result: { items: [row(description)] } });

function fixture(withSummary = true) {
  let ready = true;
  let generation = withSummary ? '1' : undefined;
  const listeners = new Set<() => void>();
  const pending: ReturnType<typeof deferred<Reply>>[] = [];
  const request = vi.fn((_operation: string, _params: unknown, _options: unknown) => {
    const work = deferred<Reply>(); pending.push(work); return work.promise;
  });
  const client = {
    get status() { return ready ? 'ready' : 'disconnected'; },
    capabilities: { operations: ['executions.list', 'executions.read', 'executions.steer', 'executions.cancel'] }, request,
    readAttachment: () => ({ state: { status: 'live', snapshot: { ...snapshot(), executionsGeneration: generation } } }),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    attach: vi.fn(), detach: vi.fn(),
  } as unknown as ConstructorParameters<typeof ClientAgentHost>[0];
  const host = new ClientAgentHost(client, 'session', () => ({ hideThinking: false, showImages: false, imageWidthCells: 60, outputPad: 1, toolMode: 'grouped' }));
  cleanups.push(async () => {
    const closing = host.dispose();
    for (const work of pending) work.resolve(reply('cleanup'));
    await closing;
  });
  const changed = () => { for (const listener of listeners) listener(); };
  return { host, request, pending,
    publish(revision: number) { generation = String(revision); changed(); },
    connection(value: boolean) { ready = value; changed(); },
  };
}

it('loads scoped protocol records even when no catalog presentation exists', async () => {
  const f = fixture(false);
  expect(f.request).toHaveBeenCalledWith('executions.list', { limit: 100 }, { session: 'session' });
  f.pending[0]!.resolve(reply('Ordinary protocol record'));
  await vi.waitFor(() => expect(f.host.getLocalSubagent('child')?.description).toBe('Ordinary protocol record'));
});

it('coalesces generic revisions arriving during a paged read without dropping the latest catalog', async () => {
  const f = fixture();
  f.pending[0]!.resolve({ outcome: 'accepted', result: { items: [], nextCursor: 'next-page' } });
  await vi.waitFor(() => expect(f.pending).toHaveLength(2));
  expect(f.request.mock.calls[1]).toEqual(['executions.list', { limit: 100, cursor: 'next-page' }, { session: 'session' }]);
  f.publish(2); f.publish(3);
  expect(f.pending).toHaveLength(2);
  f.pending[1]!.resolve(reply('Old page'));
  await vi.waitFor(() => expect(f.pending).toHaveLength(3));
  f.pending[2]!.resolve(reply('Latest catalog'));
  await vi.waitFor(() => expect(f.host.getLocalSubagent('child')?.description).toBe('Latest catalog'));
  expect(f.request).toHaveBeenCalledTimes(3);
  f.publish(3);
  expect(f.request).toHaveBeenCalledTimes(3);
});

it('refreshes on reconnect and does not start another read after disposal', async () => {
  const f = fixture();
  f.pending[0]!.resolve(reply('Initial'));
  await vi.waitFor(() => expect(f.host.getLocalSubagent('child')).toBeDefined());
  f.connection(false); f.connection(true);
  await vi.waitFor(() => expect(f.pending).toHaveLength(2));
  f.publish(2);
  const closing = f.host.dispose();
  f.pending[1]!.resolve(reply('Late result'));
  await closing;
  expect(f.host.listLocalSubagents()).toEqual([]);
  expect(f.request).toHaveBeenCalledTimes(2);
});
