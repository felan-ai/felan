import {
  createUnavailableExtensionUi, type ExtensionUi, type UiActionContext, type UiActionRequest,
  type UiDocument, type UiElementHandle, type UiInteractiveElement, type UiPresentOptions, type UiValues, type UiView,
} from '@felan-ai/agent-core';
import { parseUiPresentation } from '@felan-ai/session-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommonProcessPresentation } from '../src/common-ui.js';
import type { BackgroundBashJob, BackgroundBashStatus } from '../src/job-store.js';
import type { BackgroundProcessViewSource } from '../src/presentation.js';
import { splitProcessLog } from '../src/data.js';

const cleanups: Array<() => Promise<void>> = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function job(index = 1, status: BackgroundBashStatus = 'running', interactive = true): BackgroundBashJob {
  const meta = {
    id: `job-${index}`, command: `command ${index}`, cwd: '/private-workspace', jobDir: '/private-job',
    logPath: '/private-log', infoPath: '/private-info', completionPath: '/private-completion',
    commandPath: '/private-command', runnerPath: '/private-runner', shell: 'sh', shellArgs: [],
    startedAt: 1000, creatorPid: 42, pid: 99, processToken: 'private-token',
    executionMode: interactive ? 'pty' as const : 'detached' as const,
  };
  const state = { id: meta.id, status, startedAt: 1000, updatedAt: 2000 };
  return { meta, status: state, info: { ...meta, ...state } };
}

function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  releases.push(() => resolve(fallback));
  return { promise, resolve };
}

function fixture(initial = [job()], optimized = false) {
  let jobs = initial;
  const query = vi.fn<NonNullable<BackgroundProcessViewSource['query']>>(async (options = {}) => {
    const candidates = jobs.slice(options.cursor ? jobs.findIndex(job => job.meta.id === options.cursor) + 1 : 0);
    const rows: BackgroundBashJob[] = [];
    let scanned = 0;
    for (const candidate of candidates) {
      scanned++;
      if (!options.search || `${candidate.meta.id}\n${candidate.meta.command}`.toLowerCase().includes(options.search.toLowerCase())) rows.push(candidate);
      if (rows.length === (options.limit ?? 10) || scanned === 12) break;
    }
    const hasMore = scanned < candidates.length;
    return { jobs: rows, scanned, hasMore, ...(hasMore ? { nextCursor: candidates[scanned - 1]!.meta.id } : {}) };
  });
  const source = {
    ...(optimized ? { query } : {}),
    list: vi.fn<BackgroundProcessViewSource['list']>(async () => jobs),
    tail: vi.fn<BackgroundProcessViewSource['tail']>(async () => 'output'),
    stop: vi.fn<BackgroundProcessViewSource['stop']>(async (id) => {
      jobs = jobs.map(value => value.meta.id === id ? job(Number(id.slice(4)), 'killed') : value);
      return jobs.find(value => value.meta.id === id)!;
    }),
    write: vi.fn<NonNullable<BackgroundProcessViewSource['write']>>(async () => {}),
  };
  const controller = new AbortController();
  const rows = new Map<string, { element: UiInteractiveElement; options: UiPresentOptions; handle: UiElementHandle; closed: boolean; lifetime: AbortController }>();
  const history: UiInteractiveElement[] = [];
  const present = vi.fn<ExtensionUi['present']>(async (element, options = {}) => {
    parseUiPresentation(element);
    expect(rows.get(element.id)?.closed ?? true).toBe(true);
    const row = {
      element, options, closed: false, lifetime: new AbortController(),
      handle: {
        update: vi.fn<UiElementHandle['update']>(async update => {
          expect(row.closed).toBe(false);
          expect(update.id).toBe(row.element.id);
          expect(update.kind).toBe(row.element.kind);
          expect(update.revision).toBeGreaterThan(row.element.revision);
          parseUiPresentation(update);
          row.element = structuredClone(update); history.push(row.element);
        }),
        close: vi.fn<UiElementHandle['close']>(async () => { row.closed = true; row.lifetime.abort(); }),
      },
    };
    rows.set(element.id, row); history.push(structuredClone(element));
    return row.handle;
  });
  const ui: ExtensionUi = { ...createUnavailableExtensionUi(), present };
  const adapter = createCommonProcessPresentation(ui);
  cleanups.push(async () => { controller.abort(); await adapter.dispose(); });
  const view = (): UiView => {
    const element = [...rows.values()].find(row => row.element.kind === 'view')?.element;
    if (!element || element.kind !== 'view') throw new Error('Missing process view.');
    return element;
  };
  const document = (): UiDocument => {
    const element = [...rows.values()].find(row => row.element.kind === 'document' && !row.closed)?.element;
    if (!element || element.kind !== 'document') throw new Error('Missing process log.');
    return element;
  };
  function invoke(element: UiInteractiveElement, actionId: string, extra: Partial<UiActionRequest> = {}, signal = new AbortController().signal) {
    const row = rows.get(element.id)!;
    if (!row.options.onAction) throw new Error('Missing action handler.');
    const declared = element.actions.find(action => action.id === actionId);
    const request: UiActionRequest = {
      elementId: element.id, revision: element.revision, actionId,
      outcome: declared?.outcome ?? 'submit', values: {}, ...extra,
    };
    const context: UiActionContext = { requestId: 'test-action', signal: AbortSignal.any([
      signal, row.lifetime.signal, ...(row.options.signal ? [row.options.signal] : []),
    ]) };
    return row.options.onAction(request, context);
  }
  return { adapter, source, query, controller, present, rows, history, view, document, invoke,
    open: () => adapter.show(source, controller.signal), setJobs: (value: BackgroundBashJob[]) => { jobs = value; } };
}

describe('common process presentation', () => {
  it('opens only a bounded recent query and fetches history one explicit page at a time', async () => {
    const f = fixture(Array.from({ length: 35 }, (_, index) => job(index + 1)), true);
    await f.open();
    expect(f.query).toHaveBeenCalledExactlyOnceWith({ limit: 10 });
    expect(f.source.list).not.toHaveBeenCalled();
    expect(f.view().title).toContain('Recent processes');
    expect(f.view().items).toHaveLength(10);
    expect(f.view().paging).toBeUndefined();
    expect(f.view().query).toEqual({ actionId: 'search', values: { query: '' } });
    await f.invoke(f.view(), 'history');
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.view().title).toContain('Process history');
    expect(f.view().paging).toEqual({ nextActionId: 'next' });
    await f.invoke(f.view(), 'next');
    expect(f.query).toHaveBeenLastCalledWith({ limit: 10, cursor: 'job-10' });
    expect(f.view().items[0]?.id).toBe('job-11');
    await f.adapter.refresh();
    expect(f.query).toHaveBeenLastCalledWith({ limit: 10, cursor: 'job-10' });
    await f.invoke(f.view(), 'previous');
    expect(f.query).toHaveBeenLastCalledWith({ limit: 10 });
    expect(f.view().items[0]?.id).toBe('job-1');
    await f.invoke(f.view(), 'recent');
    expect(f.view().paging).toBeUndefined();
    expect(f.source.list).not.toHaveBeenCalled();
  });

  it('exposes a generic search input and advances empty scan batches only on request', async () => {
    const jobs = Array.from({ length: 30 }, (_, index) => job(index + 1));
    jobs[25]!.meta.command = 'Needle in old history';
    const f = fixture(jobs, true);
    await f.open();
    const search = f.view().actions.find(action => action.id === 'search')!;
    expect(search.input).toMatchObject({ fields: [{ id: 'query', kind: 'string', maxLength: 256, required: true }] });
    await f.invoke(f.view(), 'search', { values: { query: ' Needle ' } });
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.query).toHaveBeenLastCalledWith({ limit: 10, search: 'Needle' });
    expect(f.view().items).toEqual([]);
    expect(f.view().fallback).toContain('12 records scanned');
    expect(f.view().fallback).toContain('No matches in this batch; more history remains');
    expect(f.view().actions.find(action => action.id === 'next')?.label).toBe('Continue scanning');
    await f.invoke(f.view(), 'next');
    expect(f.query).toHaveBeenCalledTimes(3);
    expect(f.view().fallback).toContain('24 records scanned');
    expect(f.view().items).toEqual([]);
    await f.invoke(f.view(), 'next');
    expect(f.view().items.map(item => item.id)).toEqual(['job-26']);
    expect(f.view().fallback).toContain('30 records scanned');
    expect(f.view().paging).toEqual({ previousActionId: 'previous' });
    expect(f.view().query?.values).toEqual({ query: 'Needle' });
    await f.invoke(f.view(), 'search', { values: { query: '' } });
    expect(f.view().title).toContain('Process history');
    expect(f.view().items[0]?.id).toBe('job-1');
    expect(f.source.list).not.toHaveBeenCalled();
  });

  it('reports terminal no matches and rejects malformed searches before querying', async () => {
    const f = fixture([job()], true);
    await f.open();
    for (const values of [{}, { query: 3 }, { query: 'x'.repeat(257) }, { query: 'x', extra: true }]) {
      await expect(f.invoke(f.view(), 'search', { values })).rejects.toThrow();
    }
    expect(f.query).toHaveBeenCalledTimes(1);
    await f.invoke(f.view(), 'search', { values: { query: 'missing' } });
    expect(f.view().fallback).toContain('No matching processes');
    expect(f.view().paging).toBeUndefined();
  });

  it('shows loading, preserves the current page after a query failure, and supports retry', async () => {
    const f = fixture(Array.from({ length: 20 }, (_, index) => job(index + 1)), true);
    await f.open(); await f.invoke(f.view(), 'history');
    const waiting = deferred<Awaited<ReturnType<NonNullable<BackgroundProcessViewSource['query']>>>>({ jobs: [], hasMore: false, scanned: 0 });
    f.query.mockReturnValueOnce(waiting.promise);
    const next = f.invoke(f.view(), 'next');
    await vi.waitFor(() => expect(f.view().fallback).toContain('Loading processes'));
    waiting.resolve({ jobs: [job(11)], scanned: 1, hasMore: true, nextCursor: 'job-11' });
    await next;
    f.query.mockRejectedValueOnce(new Error('query failed'));
    await expect(f.invoke(f.view(), 'next')).rejects.toThrow('query failed');
    expect(f.view().items[0]?.id).toBe('job-11');
    expect(f.view().fallback).toContain('Refresh to retry');
    await f.invoke(f.view(), 'refresh');
    expect(f.query).toHaveBeenLastCalledWith({ limit: 10, cursor: 'job-10' });
    expect(f.view().fallback).not.toContain('Could not');
  });

  it.each(['stop', 'kill'] as const)('rechecks %s through a bounded query and never loads the full list', async control => {
    const f = fixture([job(), job(2)], true);
    await f.open(); await f.invoke(f.view(), 'read', { itemId: 'job-2' });
    await f.invoke(f.document(), control);
    expect(f.query).toHaveBeenNthCalledWith(2, { limit: 10, search: 'job-2' });
    expect(f.source.stop).toHaveBeenCalledWith('job-2', control === 'stop' ? 'SIGTERM' : 'SIGKILL');
    expect(f.source.list).not.toHaveBeenCalled();
    expect(f.document().actions.some(action => action.id === control)).toBe(false);
  });

  it('rejects stale control state and aborted queries without action leaks', async () => {
    const f = fixture([job()], true);
    await f.open(); await f.invoke(f.view(), 'read', { itemId: 'job-1' });
    f.setJobs([job(1, 'completed')]);
    await expect(f.invoke(f.document(), 'stop')).rejects.toThrow('no longer running');
    expect(f.source.stop).not.toHaveBeenCalled();
    const waiting = deferred<Awaited<ReturnType<NonNullable<BackgroundProcessViewSource['query']>>>>({ jobs: [], hasMore: false, scanned: 0 });
    f.query.mockReturnValueOnce(waiting.promise);
    const caller = new AbortController();
    const control = f.invoke(f.document(), 'kill', {}, caller.signal);
    const rejected = expect(control).rejects.toThrow();
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(3));
    caller.abort(); waiting.resolve({ jobs: [job()], scanned: 1, hasMore: false });
    await rejected;
    expect(f.source.stop).not.toHaveBeenCalled();
    expect(f.source.list).not.toHaveBeenCalled();
  });

  it('joins an aborted history query before closing its handles without publishing late rows', async () => {
    const f = fixture([job()], true);
    await f.open();
    const waiting = deferred<Awaited<ReturnType<NonNullable<BackgroundProcessViewSource['query']>>>>({ jobs: [], hasMore: false, scanned: 0 });
    f.query.mockReturnValueOnce(waiting.promise);
    const history = f.invoke(f.view(), 'history');
    const rejected = expect(history).rejects.toThrow();
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(2));
    f.controller.abort();
    let disposed = false;
    const cleanup = f.adapter.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    waiting.resolve({ jobs: [job(2)], hasMore: false, scanned: 1 });
    await rejected; await cleanup;
    expect(f.view().items[0]?.id).toBe('job-1');
    expect(f.rows.get(f.view().id)?.handle.close).toHaveBeenCalledOnce();
    expect(f.source.stop).not.toHaveBeenCalled();
    expect(f.source.write).not.toHaveBeenCalled();
  });

  it('restores the previous page after cancelling a pending search', async () => {
    const f = fixture([job()], true);
    await f.open();
    const waiting = deferred<Awaited<ReturnType<NonNullable<BackgroundProcessViewSource['query']>>>>({ jobs: [], hasMore: false, scanned: 0 });
    f.query.mockReturnValueOnce(waiting.promise);
    const caller = new AbortController();
    const search = f.invoke(f.view(), 'search', { values: { query: 'new' } }, caller.signal);
    const rejected = expect(search).rejects.toThrow();
    await vi.waitFor(() => expect(f.view().fallback).toContain('Loading'));
    caller.abort(); waiting.resolve({ jobs: [], hasMore: false, scanned: 1 });
    await rejected;
    expect(f.view().title).toContain('Recent processes');
    expect(f.view().fallback).not.toContain('Loading');
    expect(f.view().fallback).not.toContain('Could not');
    expect(f.view().items[0]?.id).toBe('job-1');
    await expect(f.invoke(f.view(), 'refresh')).resolves.toBeUndefined();
  });

  it('publishes bounded normalized rows with explicit paging, without private job metadata', async () => {
    const jobs = Array.from({ length: 20 }, (_, index) => job(index + 1));
    jobs[0]!.meta.command = 'x'.repeat(1000);
    const f = fixture(jobs);
    await f.open();
    expect(f.view().items).toHaveLength(10);
    expect(f.view().items[0]?.values.clipped).toBe(true);
    expect(f.view().paging).toBeUndefined();
    expect(f.view().actions.map(action => action.id)).toEqual(['read', 'history', 'search', 'refresh', 'close']);
    await f.invoke(f.view(), 'history');
    expect(f.view().paging).toEqual({ nextActionId: 'next' });
    const original = f.view();
    await f.invoke(original, 'next');
    expect(f.view()).toMatchObject({ id: original.id, paging: { previousActionId: 'previous' } });
    expect(f.view().revision).toBeGreaterThan(original.revision);
    expect(f.view().items.map(item => item.id)).toEqual(Array.from({ length: 10 }, (_, index) => `job-${index + 11}`));
    await f.invoke(f.view(), 'previous');
    expect(f.view().items[0]?.id).toBe('job-1');
    expect(f.view().hint).toEqual({ id: 'felan.processes', version: '1' });
    const wire = JSON.stringify(f.history);
    for (const secret of ['private-token', 'private-workspace', 'private-log', 'creatorPid', 'presenter']) expect(wire).not.toContain(secret);
  });

  it('keeps the list revision stable while reading and paging output, then reopens it on Back', async () => {
    const f = fixture();
    f.source.tail.mockResolvedValue('x'.repeat(60_000));
    await f.open();
    const list = f.view();
    await f.invoke(list, 'read', { itemId: 'job-1' });
    expect(f.view()).toEqual(list);
    expect(f.history.filter(element => element.kind === 'view')).toHaveLength(2);
    const output = f.document();
    await f.invoke(output, 'previous-output');
    expect(f.view()).toEqual(list);
    expect(f.document().revision).toBeGreaterThan(output.revision);
    await f.invoke(f.document(), 'list');
    expect(f.view().revision).toBeGreaterThan(list.revision);
    expect(f.rows.get(list.id)?.closed).toBe(false);
  });

  it('makes every bounded output chunk reachable through declared document actions', async () => {
    const f = fixture();
    const log = `first\n${'x'.repeat(60_000)}\n<script>[unsafe](file:///private)</script>\nlast`;
    const chunks = splitProcessLog(log);
    f.source.tail.mockResolvedValue(log);
    await f.open();
    await f.invoke(f.view(), 'read', { itemId: 'job-1' });
    expect(f.source.tail).toHaveBeenCalledWith('job-1', 2000);
    const logId = f.document().id;
    expect(f.document().fallback).toContain(`page ${chunks.length} of ${chunks.length}`);
    expect(f.document().markdown).toContain('&lt;script&gt;\\[unsafe\\]\\(file:///private\\)&lt;/script&gt;');
    for (let index = chunks.length - 2; index >= 0; index--) {
      const previous = f.document();
      await f.invoke(previous, 'previous-output');
      expect(f.document().id).toBe(logId);
      expect(f.document().revision).toBeGreaterThan(previous.revision);
      expect(f.document().fallback).toContain(`page ${index + 1} of ${chunks.length}`);
    }
    expect(f.document().markdown).toContain('first');
    expect(f.document().actions.some(action => action.id === 'previous-output')).toBe(false);
    await f.invoke(f.document(), 'next-output');
    expect(f.document().fallback).toContain(`page 2 of ${chunks.length}`);
    expect(f.source.tail).toHaveBeenCalledTimes(1);
    await f.invoke(f.document(), 'list');
    expect(f.rows.get(logId)?.closed).toBe(true);
    await expect(f.invoke(f.history.find(element => element.id === logId)!, 'refresh')).rejects.toThrow();
    await expect(f.invoke(f.view(), 'refresh')).resolves.toBeUndefined();
  });

  it.each(['stop', 'kill'] as const)('declares %s and exact PTY input, rechecking live process state before control', async control => {
    const f = fixture();
    await f.open();
    await f.invoke(f.view(), 'read', { itemId: 'job-1' });
    expect(f.document().actions.find(action => action.id === 'write')).toMatchObject({ input: { fields: [
      { id: 'chars', kind: 'string', label: 'Exact text or control bytes', required: true, maxLength: 32 * 1024, multiline: true },
    ] } });
    await f.invoke(f.document(), 'write', { values: { chars: '\u0003exact\n' } });
    expect(f.source.write).toHaveBeenCalledOnce();
    expect(f.source.write).toHaveBeenCalledWith('job-1', '\u0003exact\n');
    await f.invoke(f.document(), control);
    expect(f.source.stop).toHaveBeenCalledOnce();
    expect(f.source.stop).toHaveBeenCalledWith('job-1', control === 'stop' ? 'SIGTERM' : 'SIGKILL');
    expect(f.document().actions.some(action => ['write', 'stop', 'kill'].includes(action.id))).toBe(false);
    expect(f.source.list.mock.invocationCallOrder.at(-2)!).toBeLessThan(f.source.stop.mock.invocationCallOrder[0]!);
  });

  it('never exposes stdin for detached processes and refuses a process that changed before control', async () => {
    const f = fixture([job(1, 'running', false)]);
    await f.open(); await f.invoke(f.view(), 'read', { itemId: 'job-1' });
    expect(f.document().actions.some(action => action.id === 'write')).toBe(false);
    f.setJobs([job(1, 'completed', false)]);
    await expect(f.invoke(f.document(), 'stop')).rejects.toThrow('no longer running');
    expect(f.source.stop).not.toHaveBeenCalled();
    expect(f.source.write).not.toHaveBeenCalled();
    await f.invoke(f.document(), 'refresh');
    expect(f.document().actions.some(action => ['stop', 'kill'].includes(action.id))).toBe(false);
  });

  it('validates stdin fields and rechecks PTY eligibility without altering exact input', async () => {
    const f = fixture();
    await f.open(); await f.invoke(f.view(), 'read', { itemId: 'job-1' });
    f.source.list.mockClear();
    const invalid: UiValues[] = [{}, { chars: 1 }, { chars: 'text', unknown: true }, { chars: '🙂'.repeat(8193) }];
    for (const values of invalid) {
      await expect(f.invoke(f.document(), 'write', { values })).rejects.toThrow();
    }
    expect(f.source.list).not.toHaveBeenCalled();
    expect(f.source.write).not.toHaveBeenCalled();
    f.setJobs([job(1, 'running', false)]);
    await expect(f.invoke(f.document(), 'write', { values: { chars: 'unchanged\n' } })).rejects.toThrow('stdin is unavailable');
    expect(f.source.write).not.toHaveBeenCalled();
  });

  it('returns to the list when refresh discovers a removed process without aborting its own action', async () => {
    const f = fixture();
    await f.open(); await f.invoke(f.view(), 'read', { itemId: 'job-1' });
    const log = f.document();
    f.setJobs([]);
    await expect(f.invoke(log, 'refresh')).resolves.toBeUndefined();
    expect(f.rows.get(log.id)?.closed).toBe(true);
    expect(f.rows.get(log.id)?.lifetime.signal.aborted).toBe(true);
    expect(f.view().items).toEqual([]);
    await expect(f.invoke(f.view(), 'refresh')).resolves.toBeUndefined();
    expect(f.rows.get(f.view().id)?.closed).toBe(false);
  });

  it('rejects malformed, foreign, undeclared, stale, and closed actions before source access', async () => {
    const f = fixture();
    await f.open();
    const old = f.view();
    await f.invoke(old, 'refresh');
    f.source.list.mockClear();
    const current = f.view();
    const invalid: Partial<UiActionRequest>[] = [
      { revision: old.revision }, { elementId: 'foreign' }, { actionId: 'kill' },
      { itemId: 'foreign' }, { outcome: 'cancel', itemId: 'job-1' },
      { itemId: 'job-1', values: { pid: 123 } },
    ];
    for (const extra of invalid) await expect(f.invoke(current, 'read', extra)).rejects.toThrow();
    expect(f.source.list).not.toHaveBeenCalled();
    expect(f.source.tail).not.toHaveBeenCalled();
    expect(f.source.stop).not.toHaveBeenCalled();
    expect(f.source.write).not.toHaveBeenCalled();
    await f.invoke(current, 'close');
    await expect(f.invoke(current, 'read', { itemId: 'job-1' })).rejects.toThrow('closed');
    await f.adapter.dispose();
    expect(f.rows.get(current.id)?.handle.close).toHaveBeenCalledOnce();
  });

  it('serializes actions across elements and rechecks revision after a queued refresh', async () => {
    const f = fixture();
    await f.open(); await f.invoke(f.view(), 'read', { itemId: 'job-1' });
    const list = f.view(); const log = f.document();
    const waiting = deferred<BackgroundBashJob[]>([]);
    f.source.list.mockReturnValueOnce(waiting.promise);
    const refresh = f.invoke(list, 'refresh');
    await vi.waitFor(() => expect(f.source.list).toHaveBeenCalledTimes(2));
    const stop = f.invoke(log, 'stop');
    const rejected = expect(stop).rejects.toThrow();
    waiting.resolve([job()]);
    await refresh; await rejected;
    expect(f.source.stop).not.toHaveBeenCalled();
  });

  it('honors cancellation of a control while its current-state read is pending', async () => {
    const f = fixture();
    await f.open(); await f.invoke(f.view(), 'read', { itemId: 'job-1' });
    const waiting = deferred<BackgroundBashJob[]>([]);
    const caller = new AbortController();
    f.source.list.mockReturnValueOnce(waiting.promise);
    const control = f.invoke(f.document(), 'stop', {}, caller.signal);
    const rejected = expect(control).rejects.toThrow();
    await vi.waitFor(() => expect(f.source.list).toHaveBeenCalledTimes(2));
    caller.abort(); waiting.resolve([job()]);
    await rejected;
    expect(f.source.stop).not.toHaveBeenCalled();
    await expect(f.invoke(f.view(), 'refresh')).resolves.toBeUndefined();
  });

  it('cancels pending reads and awaits them before closing handles without stopping processes', async () => {
    const f = fixture();
    await f.open();
    const waiting = deferred<string>('');
    f.source.tail.mockReturnValueOnce(waiting.promise);
    const read = f.invoke(f.view(), 'read', { itemId: 'job-1' });
    const rejected = expect(read).rejects.toThrow();
    await vi.waitFor(() => expect(f.source.tail).toHaveBeenCalledOnce());
    f.controller.abort();
    let disposed = false;
    const cleanup = f.adapter.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    expect(f.rows.get(f.view().id)?.handle.close).not.toHaveBeenCalled();
    waiting.resolve('late output');
    await rejected; await cleanup;
    expect(f.present).toHaveBeenCalledOnce();
    expect(f.rows.get(f.view().id)?.handle.close).toHaveBeenCalledOnce();
    expect(f.source.stop).not.toHaveBeenCalled();
    expect(f.source.write).not.toHaveBeenCalled();
  });

  it('fences pending initial publication and closes a late-created handle exactly once', async () => {
    const f = fixture();
    const publish = f.present.getMockImplementation()!;
    const waiting = deferred<void>(undefined);
    f.present.mockImplementationOnce(async (...args) => { await waiting.promise; return publish(...args); });
    const opening = f.open();
    const rejected = expect(opening).rejects.toThrow();
    await vi.waitFor(() => expect(f.present).toHaveBeenCalledOnce());
    await expect(f.open()).rejects.toThrow('already open');
    f.controller.abort();
    const cleanup = f.adapter.dispose();
    waiting.resolve();
    await rejected; await cleanup;
    expect(f.rows.get(f.view().id)?.handle.close).toHaveBeenCalledOnce();
  });

  it('retains cleanup failures while closing both elements and rejects new actions', async () => {
    const f = fixture();
    await f.open(); await f.invoke(f.view(), 'read', { itemId: 'job-1' });
    const list = f.view(); const log = f.document();
    vi.mocked(f.rows.get(list.id)!.handle.close).mockRejectedValue(new Error('close failed'));
    await f.invoke(log, 'close');
    await expect(f.adapter.dispose()).rejects.toThrow('Process view cleanup failed');
    await expect(f.adapter.dispose()).rejects.toThrow('Process view cleanup failed');
    expect(f.rows.get(list.id)?.handle.close).toHaveBeenCalledOnce();
    expect(f.rows.get(log.id)?.handle.close).toHaveBeenCalledOnce();
    await expect(f.invoke(list, 'refresh')).rejects.toThrow('closed');
    cleanups.pop();
  });
});

it('acknowledges unchanged list refreshes and then publishes process completion', async () => {
  const f = fixture(); await f.open();
  const first = f.view();
  await f.invoke(first, 'refresh');
  expect(f.view().revision).toBeGreaterThan(first.revision);
  expect(f.view().title).toContain('1 running');
  f.setJobs([job(1, 'completed')]);
  await f.invoke(f.view(), 'refresh');
  expect(f.view().title).toContain('0 running');
  expect(f.view().items[0]?.values.status).toBe('completed');
});


it('refreshes only visible rows, avoids unchanged revisions, and stops after close', async () => {
  const jobs = Array.from({ length: 11 }, (_, index) => job(index + 1));
  const f = fixture(jobs); await f.open();
  const first = f.view();
  await f.adapter.refresh();
  expect(f.view().revision).toBe(first.revision);
  f.setJobs(jobs.map((value, index) => index === jobs.length - 1 ? job(index + 1, 'completed') : value));
  await f.adapter.refresh();
  expect(f.view().revision).toBe(first.revision);
  expect(f.view().title).toContain('10 running on page');
  f.setJobs(jobs.map((value, index) => index === 0 ? job(1, 'completed') : value));
  await f.adapter.refresh();
  expect(f.view().revision).toBe(first.revision + 1);
  expect(f.view().title).toContain('9 running on page');
  expect(f.present).toHaveBeenCalledOnce();
  await f.invoke(f.view(), 'close');
  const calls = f.source.list.mock.calls.length;
  await f.adapter.refresh();
  expect(f.source.list).toHaveBeenCalledTimes(calls);
});
