import { afterEach, expect, it, vi } from 'vitest';
import { createSilentLogger, type ExtensionContext, type FelanExtensionAPI } from '@felan-ai/agent-core';
import type { InteractionBroker } from '../src/daemon/broker.js';
import { ControlStoreError } from '../src/daemon/control-state.js';
import { createBrokerPowerlineFactory } from '../src/daemon/powerline-view.js';
import type { Presentation } from '@felan-ai/session-protocol';

afterEach(() => vi.useRealTimers());

it('reconciles capacity-deferred updates and removals without a new attachment', async () => {
  vi.useFakeTimers(); const controller = new AbortController();
  let available = true; let blocked = true; let changed = () => {};
  const values: Array<Presentation | { id: string; remove: true }> = [];
  const broker = { canPresent: () => available, subscribeClients(callback: () => void) { changed = callback; return () => {}; } } as unknown as InteractionBroker;
  const factory = createBrokerPowerlineFactory({ broker, scope: { kind: 'session', session: 's', root: 's' }, signal: controller.signal,
    ready: () => true, statuses: () => new Map(), subscribe: () => () => {}, present(value) {
      if (blocked) throw new ControlStoreError('request_capacity', 'reserved'); values.push(value);
    } });
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void | Promise<void>>();
  factory({ fetchUsage: vi.fn() }, {})({ config: { lines: [] }, runtime: { logger: createSilentLogger() },
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>) => handlers.set(name, handler),
  } as unknown as FelanExtensionAPI);
  const ctx = { mode: 'rpc', cwd: '/fixture' } as ExtensionContext;
  try {
    await handlers.get('session_start')!({}, ctx); await vi.advanceTimersByTimeAsync(0); expect(values).toHaveLength(0);
    blocked = false; await vi.advanceTimersByTimeAsync(1_000); expect(values).toHaveLength(1);
    blocked = true; available = false; changed(); expect(values).toHaveLength(1);
    blocked = false; await vi.advanceTimersByTimeAsync(1_000); expect(values.at(-1)).toMatchObject({ remove: true });
  } finally { controller.abort(); await handlers.get('session_shutdown')!({}, ctx); }
});
