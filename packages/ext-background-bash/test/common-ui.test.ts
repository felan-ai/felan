import {
  createUnavailableExtensionUi, type ExtensionUi, type UiActionContext, type UiActionRequest,
  type UiDocument, type UiElementHandle, type UiInteractiveElement, type UiPresentOptions, type UiValues, type UiView,
} from '@felan-ai/agent-core';
import { parseUiPresentation } from '@felan-ai/session-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommonProcessPresentation } from '../src/common-ui.js';
import type { BackgroundBashJob, BackgroundBashStatus } from '../src/job-store.js';
import type { BackgroundProcessViewSource } from '../src/presentation.js';
import { PROCESS_VIEW_PAGE_SIZE, splitProcessLog } from '../src/data.js';

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

function fixture(initial = [job()]) {
  let jobs = initial;
  const source = {
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
  return { adapter, source, controller, present, rows, history, view, document, invoke,
    open: () => adapter.show(source, controller.signal), setJobs: (value: BackgroundBashJob[]) => { jobs = value; } };
}

describe('common process presentation', () => {
  it('publishes bounded normalized rows with explicit paging, without private job metadata', async () => {
    const jobs = Array.from({ length: 20 }, (_, index) => job(index + 1));
    jobs[0]!.meta.command = 'x'.repeat(1000);
    const f = fixture(jobs);
    await f.open();
    expect(f.view().items).toHaveLength(PROCESS_VIEW_PAGE_SIZE);
    expect(f.view().items[0]?.values.clipped).toBe(true);
    expect(f.view().paging).toEqual({ nextActionId: 'next' });
    expect(f.view().actions.map(action => action.id)).toEqual(['read', 'next', 'refresh', 'close']);
    const original = f.view();
    await f.invoke(original, 'next');
    expect(f.view()).toMatchObject({ id: original.id, revision: original.revision + 1, paging: { previousActionId: 'previous' } });
    expect(f.view().items.map(item => item.id)).toEqual(['job-19', 'job-20']);
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
    expect(f.history.filter(element => element.kind === 'view')).toHaveLength(1);
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


it('pushes off-page completions without unchanged list revisions and stops after close', async () => {
  const jobs = Array.from({ length: PROCESS_VIEW_PAGE_SIZE + 1 }, (_, index) => job(index + 1));
  const f = fixture(jobs); await f.open();
  const first = f.view();
  await f.adapter.refresh();
  expect(f.view().revision).toBe(first.revision);
  f.setJobs(jobs.map((value, index) => index === jobs.length - 1 ? job(index + 1, 'completed') : value));
  await f.adapter.refresh();
  expect(f.view().revision).toBe(first.revision + 1);
  expect(f.view().title).toContain(`${PROCESS_VIEW_PAGE_SIZE} running`);
  expect(f.present).toHaveBeenCalledOnce();
  await f.invoke(f.view(), 'close');
  const calls = f.source.list.mock.calls.length;
  await f.adapter.refresh();
  expect(f.source.list).toHaveBeenCalledTimes(calls);
});
