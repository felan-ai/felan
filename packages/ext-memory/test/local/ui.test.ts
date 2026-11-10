import { createUnavailableExtensionUi, type ExtensionContext, type ExtensionUi, type FelanExtensionAPI } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import type { MemoryContext } from '../../src/local/context.js';
import { listLocalSessionHistory } from '../../src/local/history.js';
import type { MemoryHistorySession } from '../../src/local/history.js';
import { createMemoryPresentation } from '../../src/local/ui.js';

vi.mock('../../src/local/history.js', () => ({ listLocalSessionHistory: vi.fn(), readMemoryHistorySnapshot: vi.fn() }));

describe('memory history actions', () => {
  it.each([false, true])('omits inspect when empty (filtered: %s) but retains search and refresh recovery', async filtered => {
    const row = { name: 'Saved run', id: 'run', cwd: '/project', firstMessage: 'hello',
      modified: new Date('2026-01-01'), messageCount: 1 } as MemoryHistorySession;
    vi.mocked(listLocalSessionHistory).mockResolvedValue({ currentSessions: [], allSessions: [],
      memorySessions: new Map(filtered ? [['run', row]] : []) });
    const close = vi.fn(async () => {});
    const present = vi.fn<ExtensionUi['present']>(async () => ({ close, update: vi.fn(async () => {}) }));
    const pi = { ui: { ...createUnavailableExtensionUi(), present } } as unknown as FelanExtensionAPI;
    const ctx = { cwd: '/project', sessionManager: { getSessionDir: () => '/sessions' } } as unknown as ExtensionContext;
    const controller = new AbortController();
    const work = createMemoryPresentation(pi, {} as MemoryContext).showHistory(ctx, '/agent', 'enabled · idle · 0 pending', controller.signal);
    const act = async (index: number, actionId: string, values = {}) => {
      const [source, options] = present.mock.calls[index]!;
      await options!.onAction!({ elementId: source.id, revision: source.revision, actionId, values,
        outcome: actionId === 'close' ? 'cancel' : 'submit' }, { requestId: actionId, signal: controller.signal });
    };
    await vi.waitFor(() => expect(present).toHaveBeenCalledTimes(1));
    if (filtered) {
      await act(0, 'query', { query: 'missing' });
      await vi.waitFor(() => expect(present).toHaveBeenCalledTimes(2));
    }
    const index = filtered ? 1 : 0;
    const source = present.mock.calls[index]![0];
    expect(source).toMatchObject({ kind: 'view', items: [], query: { values: { query: filtered ? 'missing' : '' } } });
    expect(source.actions.map(action => action.id)).toEqual(['query', 'refresh', 'close']);
    await act(index, 'close');
    await work;
    expect(close).toHaveBeenCalledTimes(filtered ? 2 : 1);
  });

  it('lists recent runs first and loads every run only to search', async () => {
    const run = (id: string, name: string) => [id, { name, id, cwd: '/project', firstMessage: '', modified: new Date('2026-01-01'),
      messageCount: 1 } as MemoryHistorySession] as const;
    vi.mocked(listLocalSessionHistory).mockReset()
      .mockResolvedValueOnce({ currentSessions: [], allSessions: [], memorySessions: new Map([run('new', 'Memory: new')]),
        memorySessionsTruncated: true })
      .mockResolvedValueOnce({ currentSessions: [], allSessions: [],
        memorySessions: new Map([run('new', 'Memory: new'), run('old', 'Memory: old')]) });
    const present = vi.fn<ExtensionUi['present']>(async () => ({ close: vi.fn(async () => {}), update: vi.fn(async () => {}) }));
    const pi = { ui: { ...createUnavailableExtensionUi(), present } } as unknown as FelanExtensionAPI;
    const ctx = { cwd: '/project', sessionManager: { getSessionDir: () => '/sessions' } } as unknown as ExtensionContext;
    const controller = new AbortController();
    const work = createMemoryPresentation(pi, {} as MemoryContext).showHistory(ctx, '/agent', 'enabled', controller.signal);
    const act = async (index: number, actionId: string, values = {}) => {
      const [source, options] = present.mock.calls[index]!;
      await options!.onAction!({ elementId: source.id, revision: source.revision, actionId, values,
        outcome: actionId === 'close' ? 'cancel' : 'submit' }, { requestId: actionId, signal: controller.signal });
    };

    await vi.waitFor(() => expect(present).toHaveBeenCalledTimes(1));
    expect(vi.mocked(listLocalSessionHistory).mock.calls[0]![1]).toMatchObject({ memoryLimit: 40 });
    expect(present.mock.calls[0]![0]).toMatchObject({ fallback: expect.stringContaining('Search to include older runs'),
      items: [{ fallback: 'Memory: new' }] });

    await act(0, 'query', { query: 'old' });
    await vi.waitFor(() => expect(present).toHaveBeenCalledTimes(2));
    expect(vi.mocked(listLocalSessionHistory).mock.calls[1]![1]).not.toHaveProperty('memoryLimit');
    expect(present.mock.calls[1]![0]).toMatchObject({ fallback: 'enabled', items: [{ fallback: 'Memory: old' }] });

    await act(1, 'close');
    await work;
  });
});
