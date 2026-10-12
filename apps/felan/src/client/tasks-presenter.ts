import type { TaskDataSource, TaskState } from '@felan-ai/ext-tasks';
import { presentTaskView, type TasksNavigation } from '@felan-ai/ext-tasks/tui';
import { TASKS_PRESENTER, assembleTaskView, parseTaskViewRequest } from '@felan-ai/ext-tasks/view';
import type { Presentation } from '@felan-ai/session-protocol';
import { interactionUpdates, type ClientInteractionPresenters, type InteractionPresenterUi, type PresentationUpdatesSource } from './presenters.js';

export interface TaskPresentationUpdates {
  read(): readonly Presentation[];
  subscribe(listener: () => void): () => void;
}

export function createClientTaskSource(updates: TaskPresentationUpdates, viewId: string, signal: AbortSignal, onError: (error: unknown) => void): {
  source: TaskDataSource;
  dispose(): void;
} {
  let current: { sequence: number; state: TaskState } | undefined;
  const listeners = new Set<(state: TaskState) => void>();
  const waiters = new Set<{ resolve(state: TaskState): void; reject(error: unknown): void }>();
  let disposed = false;
  const stop = () => {
    for (const waiter of waiters) waiter.reject(signal.reason ?? new Error('Task view is closed.'));
    waiters.clear();
  };
  const update = () => {
    if (disposed || signal.aborted) return;
    try {
      const frames = updates.read().filter(item => item.kind === 'custom' && item.presenter.id === TASKS_PRESENTER.id
        && item.presenter.version === TASKS_PRESENTER.version && item.id.startsWith(`tasks:${viewId}:`))
        .map(item => item.kind === 'custom' ? item.data : null);
      if (current && frames.some(frame => typeof frame === 'object' && frame !== null && !Array.isArray(frame)
        && frame.kind === 'manifest' && typeof frame.sequence === 'number' && frame.sequence <= current!.sequence)) return;
      const next = assembleTaskView(frames, viewId);
      if (!next || current && next.sequence <= current.sequence) return;
      current = next;
      for (const waiter of waiters) waiter.resolve(structuredClone(next.state));
      waiters.clear();
      for (const listener of listeners) listener(structuredClone(next.state));
    } catch (error) { onError(error); stop(); }
  };
  const unsubscribe = updates.subscribe(update);
  signal.addEventListener('abort', stop, { once: true });
  update();
  return {
    source: {
      snapshot() {
        if (disposed || signal.aborted) return Promise.reject(signal.reason ?? new Error('Task view is closed.'));
        if (current) return Promise.resolve(structuredClone(current.state));
        return new Promise<TaskState>((resolve, reject) => waiters.add({ resolve, reject }));
      },
      subscribe(listener) {
        if (disposed || signal.aborted) throw signal.reason ?? new Error('Task view is closed.');
        listeners.add(listener);
        if (current) listener(structuredClone(current.state));
        return () => { listeners.delete(listener); };
      },
    },
    dispose() {
      if (disposed) return;
      disposed = true; unsubscribe(); signal.removeEventListener('abort', stop); listeners.clear(); stop();
    },
  };
}

export function registerTasksPresenter(presenters: Pick<ClientInteractionPresenters, 'registerCustom'>,
  ui: Pick<InteractionPresenterUi, 'custom'>, updates: PresentationUpdatesSource): () => void {
  const lifetime = new AbortController();
  const navigation = new Map<string, TasksNavigation>();
  const remove = presenters.registerCustom(TASKS_PRESENTER, async (data, signal, _document, interaction) => {
    const request = parseTaskViewRequest(data);
    const control = new AbortController();
    const combined = AbortSignal.any([signal, lifetime.signal, control.signal]);
    let failed = false; let failure: unknown;
    const source = createClientTaskSource(interactionUpdates(updates, interaction), request.viewId, combined, error => { failed = true; failure = error; control.abort(error); });
    try {
      const result = await presentTaskView(ui, source.source, request, combined, navigation.get(request.viewId));
      if (failed) throw failure;
      if (!lifetime.signal.aborted) {
        navigation.delete(request.viewId);
        if (result.action?.action !== 'close' && result.navigation) navigation.set(request.viewId, result.navigation);
        if (navigation.size > 8) navigation.delete(navigation.keys().next().value!);
      }
      return result.action ? { ...result.action } : undefined;
    } finally { source.dispose(); }
  });
  return () => { lifetime.abort(); navigation.clear(); remove(); };
}
