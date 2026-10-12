import { Text } from '@earendil-works/pi-tui';
import type { ExtensionContext } from '@felan-ai/agent-core';
import type { TaskDataSource, TasksPresentationHost } from './host.js';
import { TasksOverlay, type TasksNavigation } from './ui/tasks-overlay.js';
import type { TaskViewAction, TaskViewRequest } from './view.js';

function field(args: unknown, key: string): string {
  const value = typeof args === 'object' && args !== null ? (args as Record<string, unknown>)[key] : undefined;
  return typeof value === 'string' ? value : '';
}

export const taskRenderCalls: NonNullable<TasksPresentationHost['renderCalls']> = {
  TaskCreate: (args, theme) => new Text(theme.fg('toolTitle', theme.bold('TaskCreate ')) + theme.fg('muted', field(args, 'title')), 0, 0),
  TaskUpdate: (args, theme) => {
    const status = field(args, 'status');
    return new Text(theme.fg('toolTitle', theme.bold(`TaskUpdate ${field(args, 'task_id')}`))
      + (status ? theme.fg('muted', ` → ${status}`) : ''), 0, 0);
  },
  TaskList: (args, theme) => new Text(theme.fg('toolTitle', theme.bold('TaskList ')) + theme.fg('muted', field(args, 'view') || 'current'), 0, 0),
  TaskGet: (args, theme) => new Text(theme.fg('toolTitle', theme.bold(`TaskGet ${field(args, 'task_id')}`)), 0, 0),
};

export function createTuiTasksHost(): TasksPresentationHost {
  return {
    renderCalls: taskRenderCalls,
    async show(ui, source, displayMode, signal) {
      if (signal.aborted) return;
      let view: TasksOverlay | undefined;
      let close: (() => void) | undefined;
      const abort = () => { view?.dispose(); close?.(); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        await ui.custom<void>((tui, theme, _keys, done) => {
          close = () => done(undefined);
          view = new TasksOverlay(source, theme, close, () => tui.requestRender(), undefined, displayMode);
          if (signal.aborted) abort();
          return view;
        }, displayMode === 'overlay' ? {
          overlay: true, overlayOptions: { width: '85%', minWidth: 72, maxHeight: '90%', margin: 2 },
        } : undefined);
      } finally {
        signal.removeEventListener('abort', abort);
        view?.dispose();
      }
    },
  };
}

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

export type { TaskDataSource, TasksPresentationHost } from './host.js';
export type { TasksNavigation } from './ui/tasks-overlay.js';
