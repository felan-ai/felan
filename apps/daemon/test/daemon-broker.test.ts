import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseClientEnvelope } from '@felan-ai/session-protocol';
import { OrderedAdmission } from '../src/daemon/admission.js';
import { createRegistryInteractionBroker } from '../src/daemon/broker.js';
import { serverFixture, requestId } from './fixtures/server.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});

async function fixture(interactionHoldSeconds?: number) {
  const f = await serverFixture({ now: () => Date.now() });
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const broker = createRegistryInteractionBroker(f.registry, interactionHoldSeconds === undefined ? {} : { interactionHoldSeconds });
  const scope = { kind: 'session' as const, session: f.root.sessionId, root: f.root.sessionId };
  const request = { kind: 'confirm' as const, title: 'Continue?', message: 'Choose' };
  const admission = new OrderedAdmission(f.store);
  broker.connected({ principal: 'owner', kind: 'headless', attachment: 'client', sessions: [f.root.sessionId], interactionKinds: ['confirm'] });
  cleanups.push(async () => { await broker.drain(); vi.useRealTimers(); await f.dispose(); });
  const answer = (interactionId: string) => admission.submit(parseClientEnvelope({
    v: 1, id: requestId(), op: 'interaction.answer', session: f.root.sessionId,
    params: { interactionId, answer: { kind: 'confirm', confirmed: true } },
  }), 'owner', command => broker.dispatch(command, { principal: 'owner', kind: 'headless', attachment: 'client', interactionKinds: ['confirm'] }));
  return { ...f, broker, scope, request, answer };
}

describe('interaction hold policy', () => {
  it('waits in place until the hold ends, then defers and resumes a later answer as a continuation', async () => {
    const f = await fixture(600);
    const waiting = f.broker.request(f.request, f.scope, { deferrable: true });
    const item = f.broker.pending()[0]!;
    await vi.advanceTimersByTimeAsync(599_999);
    expect(f.broker.pending()[0]?.state).toBe('waiting');
    expect(f.broker.pending()[0]?.expiresAt).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await expect(waiting).resolves.toEqual({ state: 'deferred', interactionId: item.id });
    expect(f.broker.pending()[0]).toMatchObject({ state: 'deferred', expiresAt: Date.now() + 30 * 60 * 1000 });
    expect(await f.answer(item.id)).toMatchObject({ outcome: 'accepted' });
    await f.broker.recover();
    const continuation = f.store.snapshot().continuations[0]!;
    expect(continuation).toMatchObject({ interaction: item.id, session: f.root.sessionId, phase: 'completed' });
    expect(f.store.session(f.root.sessionId).run).toMatchObject({
      id: continuation.id, state: 'idle', origin: { kind: 'automation', source: `interaction:${item.id}` },
    });
    expect(f.broker.pending()).toEqual([]);
  });

  it('answers before the hold without deferring or creating a continuation', async () => {
    const f = await fixture(10);
    const waiting = f.broker.request(f.request, f.scope, { deferrable: true });
    const item = f.broker.pending()[0]!;
    await vi.advanceTimersByTimeAsync(9_999);
    expect(await f.answer(item.id)).toMatchObject({ outcome: 'accepted' });
    await expect(waiting).resolves.toMatchObject({ state: 'answered', answer: { confirmed: true } });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.store.snapshot().continuations).toEqual([]);
    expect(f.store.interactions()[0]?.state).toBe('answered');
  });

  it('leaves local waits indefinite when the policy is absent', async () => {
    const f = await fixture();
    const waiting = f.broker.request(f.request, f.scope, { deferrable: true });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(f.broker.pending()[0]?.state).toBe('waiting');
    await f.broker.drain();
    await expect(waiting).resolves.toMatchObject({ state: 'deferred' });
  });

  it('does not apply the hold to non-deferrable or host-scoped interactions', async () => {
    const f = await fixture(1);
    const sessionWait = f.broker.request(f.request, f.scope);
    const hostWait = f.broker.request(f.request, { kind: 'host' }, { deferrable: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.broker.pending().map(item => item.state)).toEqual(['waiting', 'waiting']);
    expect(vi.getTimerCount()).toBe(0);
    await f.broker.drain();
    await expect(sessionWait).resolves.toMatchObject({ state: 'cancelled', reason: 'drain' });
    await expect(hostWait).resolves.toMatchObject({ state: 'deferred' });
  });

  it('honors an earlier tool timeout and removes the hold timer on abort or drain', async () => {
    const f = await fixture(10);
    const timeout = f.broker.request(f.request, f.scope, { deferrable: true, timeout: 5_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(timeout).resolves.toEqual({ state: 'cancelled', reason: 'timeout' });
    expect(vi.getTimerCount()).toBe(0);
    const signal = new AbortController();
    const aborted = f.broker.request(f.request, f.scope, { deferrable: true, signal: signal.signal });
    signal.abort();
    await expect(aborted).resolves.toEqual({ state: 'cancelled', reason: 'abort' });
    expect(vi.getTimerCount()).toBe(0);
    const drained = f.broker.request(f.request, f.scope, { deferrable: true });
    await f.broker.drain();
    await expect(drained).resolves.toMatchObject({ state: 'deferred' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restores remaining hold deadlines from creation time on recovery', async () => {
    const f = await fixture(10);
    const item = { id: randomUUID(), state: 'waiting', request: f.request, scope: f.scope,
      deferrable: true, createdAt: Date.now() - 7_000 };
    f.store.putInteraction(item);
    await f.broker.recover();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(f.broker.pending()[0]?.state).toBe('waiting');
    await vi.advanceTimersByTimeAsync(1);
    expect(f.broker.pending()[0]?.state).toBe('deferred');
    await f.broker.drain();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('immediately defers overdue recovered waits and retains tool expiry', async () => {
    const f = await fixture(10);
    const expiresAt = Date.now() + 60_000;
    f.store.putInteraction({ id: randomUUID(), state: 'waiting', request: f.request, scope: f.scope,
      deferrable: true, createdAt: Date.now() - 15_000, expiresAt });
    await f.broker.recover();
    expect(f.broker.pending()[0]).toMatchObject({ state: 'deferred', expiresAt });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.broker.pending()).toEqual([]);
    expect(f.store.interactions()[0]?.state).toBe('expired');
    expect(f.store.snapshot().continuations).toEqual([]);
  });
});
