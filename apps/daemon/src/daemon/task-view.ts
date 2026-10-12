import { randomUUID } from 'node:crypto';
import type { TaskState, TasksPresentationHost } from '@felan-ai/ext-tasks';
import { TASKS_PRESENTER, createTaskViewPublication, parseTaskViewAction, type TaskViewRequest } from '@felan-ai/ext-tasks/view';
import { JsonValueSchema, parseSchema, type Interaction, type Presentation } from '@felan-ai/session-protocol';
import type { BrokerOutcome } from './broker.js';

export function createBrokerTasksHost(options: {
  signal: AbortSignal;
  present(value: Presentation | { id: string; remove: true }): void;
  request(value: Interaction['request'], dialog: { signal: AbortSignal }): Promise<BrokerOutcome>;
  unsupported(surface: string): never;
}): TasksPresentationHost {
  let active = false;
  return {
    async show(ui, source, displayMode, callerSignal) {
      if (active) { ui.notify('A task view is already open for this session.', 'warning'); return; }
      active = true;
      const control = new AbortController();
      const signal = AbortSignal.any([options.signal, callerSignal, control.signal]);
      const viewId = randomUUID();
      const published = new Set<string>();
      let selectedTaskId: string | undefined;
      let current: TaskState | undefined;
      let sequence = 0;
      let failure: unknown;
      let failed = false;
      let unsubscribe = () => {};
      const requestData = (): TaskViewRequest => ({ viewId, displayMode, ...(selectedTaskId ? { selectedTaskId } : {}) });
      const publish = () => {
        signal.throwIfAborted();
        if (!current) return;
        const publication = createTaskViewPublication(current, requestData(), ++sequence);
        const next = new Set<string>();
        for (const page of publication.pages) {
          const id = `tasks:${viewId}:${page.index}`;
          next.add(id); published.add(id);
          options.present({ id, kind: 'custom', presenter: TASKS_PRESENTER, data: parseSchema(JsonValueSchema, page) });
        }
        for (const id of published) if (!next.has(id) && !id.endsWith(':manifest')) {
          options.present({ id, remove: true }); published.delete(id);
        }
        const id = `tasks:${viewId}:manifest`; published.add(id);
        options.present({ id, kind: 'custom', presenter: TASKS_PRESENTER, data: parseSchema(JsonValueSchema, publication.manifest) });
      };
      const changed = (state: TaskState) => {
        if (signal.aborted || current && current.revision >= state.revision) return;
        current = state;
        if (selectedTaskId && !state.tasks.some(task => task.id === selectedTaskId)) selectedTaskId = undefined;
        try { publish(); } catch (error) { failed = true; failure = error; control.abort(error); }
      };
      try {
        signal.throwIfAborted();
        unsubscribe = source.subscribe(changed);
        changed(await source.snapshot());
        while (!signal.aborted) {
          const result = await options.request({ kind: 'custom', presenter: TASKS_PRESENTER, data: parseSchema(JsonValueSchema, requestData()) }, { signal });
          if (failed) throw failure;
          if (result.state !== 'answered') {
            if (result.state === 'cancelled' && result.reason === 'unsupported') options.unsupported('task view');
            return;
          }
          if (result.answer.kind !== 'custom') throw new Error('Invalid task view answer.');
          const answer = parseTaskViewAction(result.answer.data);
          if (answer.action === 'close') return;
          selectedTaskId = current?.tasks.some(task => task.id === answer.taskId) ? answer.taskId : undefined;
          publish();
        }
        if (failed) throw failure;
      } finally {
        control.abort(); unsubscribe(); active = false;
        if (!options.signal.aborted) for (const id of published) options.present({ id, remove: true });
      }
    },
  };
}
