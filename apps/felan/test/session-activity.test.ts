import { expect, it, vi } from 'vitest';
import type { SessionExecution, SessionsService } from '@felan-ai/agent-core';
import { createSessionActivity } from '../src/providers/execution-services.js';

it('tracks descendants and undelivered direct completions through Sessions', async () => {
  let changed!: () => void;
  let rows: SessionExecution[] = [{ id: 'child', parent: 'root', state: 'queued' }];
  const unsubscribe = vi.fn();
  const sessions = { current: { id: 'root', root: 'root' }, executions: vi.fn(async () => ({ items: rows })),
    subscribe(listener: () => void) { changed = listener; return unsubscribe; } } as unknown as SessionsService;
  const activity = createSessionActivity(sessions);
  const stop = activity.subscribe(() => {});
  await vi.waitFor(() => expect(activity.hasPendingWork()).toBe(true));
  expect(sessions.executions).toHaveBeenCalledWith({ includeDescendants: true });
  rows = [{ id: 'child', parent: 'root', state: 'completed', completionPending: true }]; changed();
  await Promise.resolve(); expect(activity.hasPendingWork()).toBe(true);
  rows = [{ id: 'child', parent: 'root', state: 'completed', completionPending: false }]; changed();
  await vi.waitFor(() => expect(activity.hasPendingWork()).toBe(false));
  rows = [{ id: 'grandchild', parent: 'child', state: 'running' }]; changed();
  await vi.waitFor(() => expect(activity.hasPendingWork()).toBe(true));
  stop(); expect(unsubscribe).toHaveBeenCalledOnce();
});
