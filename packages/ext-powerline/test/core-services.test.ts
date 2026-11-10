import { setImmediate as checkpoint } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import type { SessionsEvent, SessionsService } from '@felan-ai/agent-core';
import { createSessionUsage } from '../src/core-services.js';

it('aborts and joins execution-usage reads initiated by session events', async () => {
  let notify!: (event: SessionsEvent) => void;
  let finish!: () => void;
  let signal: AbortSignal | undefined;
  const entered = deferred();
  const executions = vi.fn(async (options: { signal: AbortSignal }) => {
    signal = options.signal;
    entered.resolve();
    await new Promise<void>(resolve => { finish = resolve; });
    return { items: [] };
  });
  const sessions = { current: { id: 'root', root: 'root' }, executions,
    subscribe: (listener: (event: SessionsEvent) => void) => { notify = listener; return () => {}; },
  } as unknown as SessionsService;
  const usage = createSessionUsage(sessions);
  const unsubscribe = usage.subscribe(vi.fn());
  notify({ kind: 'history', id: 'root' });
  await entered.promise;
  expect(executions).toHaveBeenCalledOnce();
  unsubscribe();
  expect(signal?.aborted).toBe(true);
  let settled = false;
  const drain = usage.settle!().then(() => { settled = true; });
  try {
    await checkpoint();
    expect(settled).toBe(false);
  } finally { finish(); await drain; }
  expect(settled).toBe(true);
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(next => { resolve = next; });
  return { promise, resolve };
}
