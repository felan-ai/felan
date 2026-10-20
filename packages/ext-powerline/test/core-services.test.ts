import { expect, it, vi } from 'vitest';
import type { SessionsEvent, SessionsService } from '@felan-ai/agent-core';
import { createSessionUsage } from '../src/core-services.js';

it('aborts and joins execution-usage reads initiated by session events', async () => {
  let notify!: (event: SessionsEvent) => void;
  let finish!: () => void;
  let signal: AbortSignal | undefined;
  const executions = vi.fn(async (options: { signal: AbortSignal }) => {
    signal = options.signal;
    await new Promise<void>(resolve => { finish = resolve; });
    return { items: [] };
  });
  const sessions = { current: { id: 'root', root: 'root' }, executions,
    subscribe: (listener: (event: SessionsEvent) => void) => { notify = listener; return () => {}; },
  } as unknown as SessionsService;
  const usage = createSessionUsage(sessions);
  const unsubscribe = usage.subscribe(vi.fn());
  notify({ kind: 'history', id: 'root' });
  expect(executions).toHaveBeenCalledOnce();
  unsubscribe();
  expect(signal?.aborted).toBe(true);
  let settled = false;
  const drain = usage.settle!().then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  finish();
  await drain;
  expect(settled).toBe(true);
});
