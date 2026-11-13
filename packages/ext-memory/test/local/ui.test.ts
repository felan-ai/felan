import { createUnavailableExtensionUi, type ExtensionContext, type ExtensionUi, type FelanExtensionAPI } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import type { MemoryContext } from '../../src/local/context.js';
import { listLocalSessionHistory } from '../../src/local/history.js';
import type { MemoryHistorySession } from '../../src/local/history.js';
import { createMemoryPresentation } from '../../src/local/ui.js';

vi.mock('../../src/local/history.js', () => ({ listLocalSessionHistory: vi.fn(), readMemoryHistorySnapshot: vi.fn() }));

function directoryFixture(code = 0, stderr = '', killed = false) {
  const exec = vi.fn(async () => ({ code, stderr, killed, stdout: '' }));
  const request = vi.fn<ExtensionUi['request']>().mockResolvedValue({ state: 'answered', answer: { kind: 'form', outcome: 'submit', actionId: 'open', values: {} } });
  const pi = { ui: { request }, runtime: { exec } } as unknown as FelanExtensionAPI;
  return { exec, request, presentation: createMemoryPresentation(pi, {} as MemoryContext), signal: new AbortController().signal };
}

describe('open memory directory', () => {
  it('uses literal argv only after host confirmation', async () => {
    const { exec, request, presentation, signal } = directoryFixture();
    await presentation.openDirectory('memory with spaces', signal);
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
    expect(exec).toHaveBeenCalledWith(command, ['memory with spaces']);
    expect(request).toHaveBeenCalledWith(expect.anything(), { audience: 'host', signal });
    exec.mockClear();
    request.mockResolvedValue({ state: 'answered', answer: { kind: 'form', outcome: 'cancel', actionId: 'close', values: {} } });
    await presentation.openDirectory('memory with spaces', signal);
    expect(exec).not.toHaveBeenCalled();
  });

  it('reports an opener failure', async () => {
    const { presentation, signal } = directoryFixture(17);
    await expect(presentation.openDirectory('memory', signal)).rejects.toThrow('Memory directory could not be opened.');
  });

  it.skipIf(process.platform === 'win32')('keeps exit code 1 as a failure on POSIX', async () => {
    const { presentation, signal } = directoryFixture(1);
    await expect(presentation.openDirectory('memory', signal)).rejects.toThrow('Memory directory could not be opened.');
  });

  it.runIf(process.platform === 'win32')('accepts Explorer exit code 1 without treating spawn errors or termination as success', async () => {
    const { presentation, signal } = directoryFixture(1);
    await expect(presentation.openDirectory('memory', signal)).resolves.toBeUndefined();
    for (const [stderr, killed] of [['spawn ENOENT', false], ['', true]] as const) {
      const failure = directoryFixture(1, stderr, killed);
      await expect(failure.presentation.openDirectory('memory', failure.signal)).rejects.toThrow('Memory directory could not be opened.');
    }
  });
});

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
