import { expect, it, vi } from 'vitest';
import { InteractionBroker } from '../src/daemon/broker.js';
import type { DaemonControlStore } from '../src/daemon/control-store.js';

it('keeps transient host forms out of persistence and cancels when the local console detaches', async () => {
  const putInteraction = vi.fn(() => { throw new Error('Transient form must not be persisted'); });
  const store = { owner: { assertCurrent() {} }, snapshot: () => ({ clock: 0, interactions: [], continuations: [] }), interactions: () => [], putInteraction } as unknown as DaemonControlStore;
  const publish = vi.fn();
  const broker = new InteractionBroker({ store, ownerPrincipal: 'owner', publish });
  broker.connected({ principal: 'owner', kind: 'tui', attachment: 'console', sessions: [],
    interactionKinds: ['form'], localConsole: true });
  const form = { title: 'Authorize', fallback: 'Authorize locally', description: 'https://auth.test/authorize?state=private',
    input: { fields: [] }, actions: [{ id: 'cancel', label: 'Cancel', target: 'element' as const, outcome: 'cancel' as const }] };
  expect(() => broker.request({ kind: 'form', form }, { kind: 'host' }, { transient: true, deferrable: true }))
    .toThrow();
  expect(() => broker.request({ kind: 'form', form }, { kind: 'session', session: 's', root: 's' }, { transient: true }))
    .toThrow();
  const waiting = broker.request({ kind: 'form', form }, { kind: 'host' }, { transient: true, deferrable: false });
  expect(broker.pending()).toHaveLength(1);
  expect(putInteraction).not.toHaveBeenCalled();
  expect(publish).toHaveBeenCalledWith(expect.objectContaining({ authority: 'local-console' }), {});
  broker.disconnected('console');
  await expect(waiting).resolves.toEqual({ state: 'cancelled', reason: 'unsupported' });
  expect(broker.pending()).toEqual([]);
  expect(putInteraction).not.toHaveBeenCalled();
  await broker.drain();
});
