import { createElementNavigation } from './navigation.js';
import type { UiActionRequest, UiPresentation } from '@felan-ai/agent-core';
import { Text } from '@earendil-works/pi-tui';
import type { ExtensionContext } from '@felan-ai/agent-core';
import type { TaskDataSource } from '@felan-ai/ext-tasks/data';
import type { AgentToolPresentation } from '../../subagents/agent-transcript.js';
import { TasksOverlay, type TasksNavigation } from './tasks/tasks-overlay.js';
import type { TaskViewAction, TaskViewRequest } from '@felan-ai/ext-tasks/data';

function field(args: unknown, key: string): string {
  const value = typeof args === 'object' && args !== null ? (args as Record<string, unknown>)[key] : undefined;
  return typeof value === 'string' ? value : '';
}

export const taskRenderCalls: Record<'TaskCreate' | 'TaskUpdate' | 'TaskList' | 'TaskGet', NonNullable<AgentToolPresentation['renderCall']>> = {
  TaskCreate: (args, theme) => new Text(theme.fg('toolTitle', theme.bold('TaskCreate ')) + theme.fg('muted', field(args, 'title')), 0, 0),
  TaskUpdate: (args, theme) => {
    const status = field(args, 'status');
    return new Text(theme.fg('toolTitle', theme.bold(`TaskUpdate ${field(args, 'task_id')}`))
      + (status ? theme.fg('muted', ` → ${status}`) : ''), 0, 0);
  },
  TaskList: (args, theme) => new Text(theme.fg('toolTitle', theme.bold('TaskList ')) + theme.fg('muted', field(args, 'view') || 'current'), 0, 0),
  TaskGet: (args, theme) => new Text(theme.fg('toolTitle', theme.bold(`TaskGet ${field(args, 'task_id')}`)), 0, 0),
};

export async function presentTaskView(ui: Pick<ExtensionContext['ui'], 'custom'>, source: TaskDataSource,
  request: TaskViewRequest, signal: AbortSignal, initial?: TasksNavigation): Promise<{ action?: TaskViewAction; navigation?: TasksNavigation }> {
  if (signal.aborted) return {};
  let view: TasksOverlay | undefined;
  let finish: ((value?: TaskViewAction) => void) | undefined;
  let finished = false;
  const abort = () => finish?.();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const action = await ui.custom<TaskViewAction | undefined>((tui, theme, _keys, done) => {
      finish = value => { if (!finished) { finished = true; view?.dispose(); done(value); } };
      const selected = initial ?? (request.selectedTaskId ? { view: 'detail' as const, selectedTaskId: request.selectedTaskId, scroll: 0, contentScroll: 0 } : undefined);
      view = new TasksOverlay(source, theme, () => finish?.({ action: 'close' }), () => tui.requestRender(), undefined,
        request.displayMode, { ...(selected ? { initial: selected } : {}), requestDetails: taskId => finish?.({ action: 'detail', taskId }) });
      if (signal.aborted) abort();
      return view;
    }, request.displayMode === 'overlay' ? { overlay: true, overlayOptions: { width: '85%', minWidth: 72, maxHeight: '90%', margin: 2 } } : undefined);
    return { ...(action ? { action } : {}), ...(view ? { navigation: view.snapshotNavigation() } : {}) };
  } finally { signal.removeEventListener('abort', abort); view?.dispose(); }
}

export type { TaskDataSource } from '@felan-ai/ext-tasks/data';
export type { TasksNavigation } from './tasks/tasks-overlay.js';

export { TASKS_HINT } from '@felan-ai/ext-tasks/data';

const elementNavigation = createElementNavigation<TasksNavigation>();

export async function presentTasksElement(value: UiPresentation, ui: Pick<ExtensionContext['ui'], 'custom'>,
  signal: AbortSignal, actions: (source: UiPresentation, signal: AbortSignal, actionId?: string, itemId?: string) => Promise<UiActionRequest | undefined>,
  displayMode: 'inline' | 'overlay' = 'inline'): Promise<UiActionRequest | undefined> {
  const source = value;
  if (source.kind !== 'view' && source.kind !== 'document') throw new Error('Expected a view or document.');
  if (signal.aborted) return undefined;
  type Choice = { actionId: string; itemId?: string } | 'actions' | undefined;
  let panel: TasksOverlay | undefined;
  let finish: (choice: Choice) => void = () => {};
  const abort = () => { panel?.dispose(); finish(undefined); };
  signal.addEventListener('abort', abort, { once: true });
  let choice: Choice;
  try {
    choice = await ui.custom<Choice>((tui, theme, _keys, done) => {
      let settled = false;
      finish = result => { if (!settled) { settled = true; panel?.dispose(); done(result); } };
      const choose = (actionId?: string, itemId?: string) => {
        if (actionId === undefined) { finish('actions'); return; }
        const action = source.actions.find(entry => entry.id === actionId);
        if (!action || action.target === 'item' && (source.kind !== 'view' || !source.items.some(item => item.id === itemId))) return;
        finish({ actionId, ...(itemId === undefined ? {} : { itemId }) });
      };
      panel = new TasksOverlay(undefined, theme, () => finish(undefined), () => tui.requestRender(), undefined, displayMode, { ...(elementNavigation.has(source.id) ? { initial: elementNavigation.get(source.id)! } : {}) }, { source, action: choose });
      if (signal.aborted) abort();
      return panel;
    }, displayMode === 'overlay' ? { overlay: true, overlayOptions: { width: '85%', minWidth: 72, maxHeight: '90%', margin: 2 } } : undefined);
  } finally { signal.removeEventListener('abort', abort); if (panel) elementNavigation.set(source.id, panel.snapshotNavigation()); panel?.dispose(); }
  if (signal.aborted || choice === undefined) return undefined;
  const result = choice === 'actions' ? await actions(source, signal) : source.actions.find(action => action.id === choice.actionId)?.input?.fields.length
    ? await actions(source, signal, choice.actionId, choice.itemId) : { elementId: source.id, revision: source.revision,
    actionId: choice.actionId, outcome: source.actions.find(action => action.id === choice.actionId)!.outcome,
    values: {}, ...(choice.itemId === undefined ? {} : { itemId: choice.itemId }) };
  return signal.aborted ? undefined : result;
}
