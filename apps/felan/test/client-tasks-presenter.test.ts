import { expect, it, vi } from 'vitest';
import type { TaskState } from '@felan-ai/ext-tasks';
import { createTaskViewPublication, TASKS_PRESENTER } from '@felan-ai/ext-tasks/view';
import { parseSchema, PresentationSchema, type Interaction, type Presentation } from '@felan-ai/session-protocol';
import { ClientInteractionPresenters, type InteractionPresenterUi } from '../src/client/presenters.js';
import { createClientTaskSource, registerTasksPresenter } from '../src/client/tasks-presenter.js';

const state: TaskState = { schemaVersion: 1, revision: 1, tasks: [{ id: 'T-AAAAAA', title: 'First', priority: 1,
  status: 'pending', blockedBy: [], createdAt: '2026', updatedAt: '2026', notes: 'Full details' }] };

function updates() {
  const listeners = new Set<() => void>(); let values: Presentation[] = [];
  const replace = (next: Presentation[]) => { values = next; for (const listener of listeners) listener(); };
  return { listeners, replace, read: () => values, subscribe(callback: () => void) { listeners.add(callback); return () => { listeners.delete(callback); }; } };
}
function publication(next: TaskState, sequence: number, selectedTaskId?: string) {
  const value = createTaskViewPublication(next, { viewId: 'view', displayMode: 'inline', ...(selectedTaskId ? { selectedTaskId } : {}) }, sequence);
  return [...value.pages.map(page => ({ id: `tasks:view:${page.index}`, kind: 'custom', presenter: TASKS_PRESENTER, data: page })),
    { id: 'tasks:view:manifest', kind: 'custom', presenter: TASKS_PRESENTER, data: value.manifest }].map(item => parseSchema(PresentationSchema, item));
}

it('retains the last complete snapshot while a new publication is incomplete', async () => {
  const stream = updates(); stream.replace(publication(state, 1)); const control = new AbortController();
  const fail = vi.fn(); const source = createClientTaskSource(stream, 'view', control.signal, fail);
  expect((await source.source.snapshot()).tasks[0]!.title).toBe('First');
  const next = publication({ ...state, revision: 2, tasks: [{ ...state.tasks[0]!, title: 'Second' }] }, 2);
  stream.replace([stream.read()[0]!, next.at(-1)!]);
  expect((await source.source.snapshot()).tasks[0]!.title).toBe('First');
  stream.replace(next);
  expect((await source.source.snapshot()).tasks[0]!.title).toBe('Second');
  expect(fail).not.toHaveBeenCalled(); source.dispose(); expect(stream.listeners.size).toBe(0);
});

it('aborts an incomplete initial snapshot and reports malformed data', async () => {
  const stream = updates(); const control = new AbortController();
  const failure = vi.fn((error: unknown) => control.abort(error));
  const source = createClientTaskSource(stream, 'view', control.signal, failure);
  const pending = source.source.snapshot();
  stream.replace([{ id: 'tasks:view:manifest', kind: 'custom', presenter: TASKS_PRESENTER, data: { kind: 'manifest', viewId: 'view', sequence: -1 } }]);
  await expect(pending).rejects.toThrow('Invalid task presentation'); expect(failure).toHaveBeenCalledTimes(1); source.dispose();
});

it('presents the existing task component and retains navigation through a detail round trip', async () => {
  const stream = updates(); stream.replace(publication(state, 1)); let panel: { handleInput(value: string): void; render(width: number): string[] } | undefined;
  const custom = vi.fn((factory: (...args: unknown[]) => unknown) => new Promise(resolve => {
    panel = factory({ requestRender() {} }, { fg: (_key: string, text: string) => text, bold: (text: string) => text }, {}, resolve) as typeof panel;
  }));
  const ui = { custom, notify: vi.fn() } as unknown as InteractionPresenterUi;
  const presenters = new ClientInteractionPresenters(ui); const remove = registerTasksPresenter(presenters, ui, stream);
  const interaction = (id: string, selectedTaskId?: string): Interaction => ({ id, state: 'waiting', createdAt: Date.now(), eligibleClientKinds: ['tui'],
    scope: { kind: 'session', session: 'session', root: 'session' }, request: { kind: 'custom', presenter: TASKS_PRESENTER,
      data: { viewId: 'view', displayMode: 'inline', ...(selectedTaskId ? { selectedTaskId } : {}) } } });
  const first = presenters.present(interaction('first'), new AbortController().signal);
  await vi.waitFor(() => expect(panel).toBeDefined());
  panel!.handleInput('\r');
  expect(await first).toMatchObject({ state: 'answered', answer: { data: { action: 'detail', taskId: 'T-AAAAAA' } } });
  stream.replace(publication(state, 2, 'T-AAAAAA')); panel = undefined;
  const second = presenters.present(interaction('second', 'T-AAAAAA'), new AbortController().signal);
  await vi.waitFor(() => expect(panel).toBeDefined());
  panel!.render(100); panel!.handleInput('end');
  expect(panel!.render(100).join('\n')).toContain('Full details');
  panel!.handleInput('q'); expect(await second).toMatchObject({ state: 'answered', answer: { data: { action: 'close' } } });
  remove(); expect(stream.listeners.size).toBe(0);
});
