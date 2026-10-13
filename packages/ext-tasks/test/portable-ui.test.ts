import { createUnavailableExtensionUi, type ExtensionUi, type UiActionRequest, type UiInteractiveElement, type UiPresentOptions } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import type { TaskState } from '../src/contracts.js';
import { cloneTaskState, createTask, emptyTaskState, updateTask } from '../src/graph.js';
import type { TaskDataSource, TaskPresentationMutations } from '../src/host.js';
import { createTasksUi } from '../src/portable-ui.js';

const legacyUi = {} as Parameters<ReturnType<typeof createTasksUi>['show']>[0];
const id = (index: number) => `T-${index.toString(16).toUpperCase().padStart(6, '0')}`;
function graph(count = 3): TaskState {
  let state = emptyTaskState();
  for (let index = 0; index < count; index++) state = createTask(state, { title: `Task ${index}`, description: `Full description ${index}` }, id(index), '2026-01-01').state;
  return state;
}

function harness(initial = graph(), writable = true) {
  let state = initial;
  let current!: UiInteractiveElement;
  let callbacks!: UiPresentOptions;
  const listeners = new Set<(state: TaskState) => void>();
  const publish = (next: TaskState) => { state = next; for (const listener of listeners) listener(cloneTaskState(state)); };
  const source: TaskDataSource = {
    snapshot: vi.fn(async () => cloneTaskState(state)),
    subscribe: vi.fn<TaskDataSource['subscribe']>(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
  };
  const mutations: TaskPresentationMutations = {
    create: vi.fn<TaskPresentationMutations['create']>(async (input, signal) => {
      signal.throwIfAborted();
      const result = createTask(state, input, id(state.tasks.length), '2026-01-02'); publish(result.state); return result;
    }),
    update: vi.fn<TaskPresentationMutations['update']>(async (input, signal) => {
      signal.throwIfAborted();
      const result = updateTask(state, input, 'session', '2026-01-02'); publish(result.state); return result;
    }),
  };
  const close = vi.fn(async () => {});
  const updates: UiInteractiveElement[] = [];
  const ui: ExtensionUi = { ...createUnavailableExtensionUi(), present: vi.fn<ExtensionUi['present']>(async (element, options) => {
    current = element; callbacks = options!;
    return { update: async next => {
      expect(next.kind).toBe(element.kind); expect(next.id).toBe(element.id);
      updates.push(next); current = next;
    }, close };
  }) };
  const controller = new AbortController();
  const work = createTasksUi(ui).show(source, controller.signal, writable ? mutations : undefined);
  const ready = async () => { await vi.waitFor(() => expect(ui.present).toHaveBeenCalledOnce()); await tick(); };
  const act = async (actionId: string, values: UiActionRequest['values'] = {}, itemId?: string, overrides: Partial<UiActionRequest> = {}, signal = new AbortController().signal) => {
    const request: UiActionRequest = { elementId: current.id, revision: current.revision, actionId, outcome: actionId === 'close' ? 'cancel' : 'submit', values,
      ...(itemId === undefined ? {} : { itemId }), ...overrides };
    await callbacks.onAction!(request, { requestId: 'test', signal });
  };
  return { source, mutations, close, updates, controller, work, ready, act, publish, current: () => current, state: () => state, listeners };
}

describe('portable task view', () => {
  it('shows complete task rows and filters, pages, opens details, and navigates back without native UI', async () => {
    const h = harness(graph(25)); await h.ready();
    try {
      const overview = h.current();
      expect(overview.kind).toBe('view'); expect(overview.hint).toEqual({ id: 'felan.tasks', version: '1' });
      if (overview.kind !== 'view') throw new Error('Expected overview');
      expect(overview.items).toHaveLength(20);
      expect(overview.items[0]?.values).toMatchObject({ id: id(0), title: 'Task 0', priority: 2, status: 'pending', availability: 'ready', blockedBy: '', owner: '' });
      expect(overview.paging).toEqual({ nextActionId: 'next' });
      await h.act('next');
      const next = h.current();
      if (next.kind !== 'view') throw new Error('Expected overview');
      expect(next.items).toHaveLength(5);
      await h.act('detail', {}, next.items[0]!.id);
      expect(h.current()).toMatchObject({ kind: 'document', markdown: expect.stringContaining('Full description 20') });
      await h.act('back');
      await h.act('filter', { filter: 'all', search: 'Task 24' });
      const filtered = h.current();
      if (filtered.kind !== 'view') throw new Error('Expected overview');
      expect(filtered.items.map(item => item.id)).toEqual([id(24)]);
    } finally { await h.act('close'); await h.work; }
    expect(h.close).toHaveBeenCalledTimes(3); expect(h.listeners.size).toBe(0);
  });

  it('exposes explicit create/update fields and preserves claim, dependency, and completion rules', async () => {
    const h = harness(); await h.ready();
    try {
      await h.act('create', { title: 'Blocked follow-up', blockedBy: id(0), priority: 1 });
      expect(h.current()).toMatchObject({ kind: 'document', markdown: expect.stringContaining('Availability: waiting') });
      await expect(h.act('update', { status: 'in_progress' })).rejects.toThrow('waiting on');
      expect(h.state().tasks[3]?.status).toBe('pending');
      await h.act('update', { removeBlockedBy: id(0), status: 'in_progress', notes: 'Owned work' });
      expect(h.state().tasks[3]).toMatchObject({ ownerSessionId: 'session', status: 'in_progress', notes: 'Owned work' });
      await expect(h.act('update', { status: 'completed' })).rejects.toThrow('result');
      await h.act('update', { status: 'completed', result: 'Checked acceptance criteria' });
      expect(h.state().tasks[3]).toMatchObject({ status: 'completed', result: 'Checked acceptance criteria' });
      expect(h.state().tasks[3]?.ownerSessionId).toBeUndefined();
    } finally { await h.act('close'); await h.work; }
  });

  it('does not override another owner without an explicit force field', async () => {
    const state = updateTask(graph(), { taskId: id(0), status: 'in_progress' }, 'other-session', '2026-01-02').state;
    const h = harness(state); await h.ready();
    try {
      await h.act('detail', {}, id(0));
      await expect(h.act('update', { notes: 'Do not steal ownership' })).rejects.toThrow('not_owner');
      await h.act('update', { status: 'in_progress', force: true, notes: 'Recover stale claim' });
      expect(h.state().tasks[0]?.ownerSessionId).toBe('session');
    } finally { await h.act('close'); await h.work; }
  });

  it('refreshes subscribed state and rejects old revisions, hidden rows, and malformed fields', async () => {
    const h = harness(graph(25)); await h.ready();
    try {
      const revision = h.current().revision;
      h.publish(createTask(h.state(), { title: 'New task' }, id(25), '2026-01-03').state);
      await vi.waitFor(() => expect(h.current().revision).toBeGreaterThan(revision));
      await expect(h.act('create', { title: 'Stale' }, undefined, { revision })).rejects.toThrow('Stale');
      await expect(h.act('detail', {}, id(24))).rejects.toThrow('current page');
      await expect(h.act('create', { title: 'Invalid', force: true })).rejects.toThrow('Unexpected');
      await expect(h.act('create', { title: '', priority: 2 })).rejects.toThrow('Invalid');
      await expect(h.act('create', { title: 'Invalid', priority: 1.2 })).rejects.toThrow('Invalid');
      await expect(h.act('create', { title: 'Invalid', blockedBy: '../private' })).rejects.toThrow('prerequisite');
      expect(h.mutations.create).not.toHaveBeenCalled();
    } finally { await h.act('close'); await h.work; }
  });

  it('revalidates the snapshot even when no subscription notification was delivered', async () => {
    const h = harness(); await h.ready();
    try {
      vi.mocked(h.source.snapshot).mockResolvedValueOnce(createTask(h.state(), { title: 'External task' }, id(3), '2026-01-03').state);
      await expect(h.act('create', { title: 'Stale create' })).rejects.toThrow('state changed');
      expect(h.mutations.create).not.toHaveBeenCalled();
    } finally { await h.act('close'); await h.work; }
  });

  it('rejects cancelled mutations before dispatch and closes/drains on lifetime cancellation', async () => {
    const h = harness(); await h.ready();
    const cancelled = new AbortController(); cancelled.abort();
    await expect(h.act('create', { title: 'Not created' }, undefined, {}, cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.mutations.create).not.toHaveBeenCalled();
    h.controller.abort(); await h.work;
    expect(h.close).toHaveBeenCalledOnce(); expect(h.listeners.size).toBe(0);
    await expect(h.act('create', { title: 'Closed' })).rejects.toThrow('closed');
  });

  it('drains already-dispatched mutations without falsely reporting rollback on cancellation', async () => {
    const h = harness(); await h.ready();
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    vi.mocked(h.mutations.create).mockImplementation(async input => {
      const result = createTask(h.state(), input, id(3), '2026-01-03');
      await pending;
      h.publish(result.state);
      return result;
    });
    const mutation = h.act('create', { title: 'Committed work' });
    await vi.waitFor(() => expect(h.mutations.create).toHaveBeenCalledOnce());
    let stopped = false;
    const shutdown = h.work.then(() => { stopped = true; });
    h.controller.abort();
    await tick();
    expect(stopped).toBe(false);
    finish();
    await mutation; await shutdown;
    expect(h.state().tasks[3]?.title).toBe('Committed work');
  });

  it('escapes hostile Markdown and pages all detail content instead of truncating', async () => {
    let state = graph(1);
    state = { ...state, tasks: [{ ...state.tasks[0]!, title: '<script>x</script> [x](javascript:bad)', notes: 'NOTE_END' }] };
    for (let index = 1; index < 25; index++) state = createTask(state, { title: `<${'x'.repeat(7990)}>`, blockedBy: [id(0)] }, id(index), '2026-01-01').state;
    const h = harness(state, false); await h.ready();
    try {
      await h.act('detail', {}, id(0));
      const pages: string[] = [];
      while (true) {
        const document = h.current();
        if (document.kind !== 'document') throw new Error('Expected document');
        pages.push(document.markdown);
        expect(new TextEncoder().encode(JSON.stringify(document)).byteLength).toBeLessThanOrEqual(256 * 1024);
        if (!document.actions.some(action => action.id === 'next')) break;
        await h.act('next');
      }
      expect(pages.length).toBeGreaterThan(1);
      const full = pages.join('\n');
      expect(full).toContain('NOTE\\_END');
      expect(full).toContain(id(24));
      expect(full).not.toMatch(/<\/?[a-z]|\]\(/iu);
    } finally { await h.act('close'); await h.work; }
  });
});

async function tick() { await new Promise<void>(resolve => setTimeout(resolve, 0)); }
