import { TASKS_HINT } from './data.js';
import type { ExtensionUi, UiActionRequest, UiAction, UiElementHandle, UiField, UiInteractiveElement, UiPresentOptions, UiValues, UiView } from '@felan-ai/agent-core';
import { TASK_STATUS_VALUES, TASK_VIEW_VALUES, type CreateTaskInput, type Task, type TaskState, type TaskView, type UpdateTaskInput } from './contracts.js';
import { getTask, listTasks, TASK_ID_PATTERN, taskAvailability, taskCounts, taskDependents } from './graph.js';
import type { TaskDataSource, TaskPresentationMutations } from './host.js';
import { assembleTaskView, createTaskViewPublication } from './data.js';


const PAGE_SIZE = 20;
const encoder = new TextEncoder();
const field = (id: string, label: string, maxLength: number, required = false): UiField => ({ id, label, kind: 'string', required, maxLength, multiline: maxLength > 500 });
const priority: UiField = { id: 'priority', label: 'Priority (0 highest, 4 lowest)', kind: 'number', minimum: 0, maximum: 4, required: false };
const createFields: UiField[] = [field('title', 'Title', 200, true), field('description', 'Description', 4000), field('acceptanceCriteria', 'Acceptance criteria', 4000), priority, field('blockedBy', 'Prerequisite IDs, separated by commas', 320)];
const updateFields: UiField[] = [
  field('title', 'Title', 200), field('description', 'Description', 4000), field('acceptanceCriteria', 'Acceptance criteria', 4000), priority,
  { id: 'status', label: 'New status (completion requires a result; blocked requires a reason)', kind: 'enum', required: false, options: TASK_STATUS_VALUES.map(id => ({ id, label: id })) },
  field('addBlockedBy', 'Add prerequisite IDs, separated by commas', 320), field('removeBlockedBy', 'Remove prerequisite IDs, separated by commas', 320),
  field('notes', 'Handoff notes', 8000), field('result', 'Verified completion result', 8000), field('blockedReason', 'External blocker', 2000),
  { id: 'force', label: 'Recover another session’s stale claim (explicit recovery only)', kind: 'boolean', required: false },
];
const action = (id: string, label: string, fields?: UiField[]): UiAction => ({ id, label, target: 'element', outcome: 'submit', ...(fields ? { input: { fields } } : {}) });
const closeAction: UiAction = { id: 'close', label: 'Close tasks', target: 'element', outcome: 'cancel' };

export function createTasksUi(ui: ExtensionUi) {
  let sequence = 0;
  return {
    async show(source: TaskDataSource, signal: AbortSignal, mutations?: TaskPresentationMutations) {
      signal.throwIfAborted();
      const id = `tasks-${++sequence}`;
      let revision = 0;
      let graphRevision = -1;
      let filter: TaskView = 'current';
      let search = '';
      let page = 0;
      let selected: string | undefined;
      let detailPage = 0;
      let pageCount = 1;
      let current: UiInteractiveElement;
      let handle: UiElementHandle | undefined;
      let handleKind: UiInteractiveElement['kind'] | undefined;
      let unsubscribe: (() => void) | undefined;
      let closing = false;
      let failure: unknown;
      let closeWork: Promise<void> | undefined;
      let resolveClosed!: () => void;
      const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
      let queue = Promise.resolve();
      const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
        const work = queue.then(operation);
        queue = work.then(() => {}, () => {});
        return work;
      };
      const close = async (): Promise<void> => {
        closing = true;
        unsubscribe?.(); unsubscribe = undefined;
        if (!handle) { resolveClosed(); return; }
        closeWork ??= Promise.resolve().then(() => handle!.close())
          .catch(error => { failure ??= error; }).then(resolveClosed);
        await closeWork;
      };
      const fail = (error: unknown) => { failure ??= error; void close(); };
      const abort = () => { void close(); };
      const render = async (snapshot: TaskState): Promise<void> => {
        if (closing) return;
        signal.throwIfAborted();
        if (selected && !snapshot.tasks.some(task => task.id === selected)) selected = undefined;
        const publication = createTaskViewPublication(snapshot, { viewId: id, displayMode: 'inline', ...(selected ? { selectedTaskId: selected } : {}) }, revision);
        const state = assembleTaskView([publication.manifest, ...publication.pages], id)!.state;
        graphRevision = state.revision;
        revision++;
        if (selected) {
          const task = getTask(state, selected);
          const pages = documentPages(taskDocument(state, task));
          pageCount = pages.length;
          detailPage = Math.min(detailPage, pageCount - 1);
          current = {
            kind: 'document', hint: TASKS_HINT, id: `${id}-detail`, revision,
            title: `Task ${task.id} — page ${detailPage + 1}/${pageCount}`,
            markdown: pages[detailPage]!, fallback: `Task ${task.id}, graph revision ${graphRevision}, detail page ${detailPage + 1} of ${pageCount}.`,
            actions: [action('back', 'Back to tasks'), action('open', 'Open related task', [field('taskId', 'Task ID', 8, true)]),
              ...(detailPage > 0 ? [action('previous', 'Previous detail page')] : []),
              ...(detailPage + 1 < pageCount ? [action('next', 'Next detail page')] : []),
              ...(mutations ? [action('update', 'Update this task', updateFields)] : []), action('refresh', 'Refresh'), closeAction],
          };
        } else {
          const tasks = listTasks(state, filter).filter(task => `${task.id} ${task.title}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
          pageCount = Math.max(1, Math.ceil(tasks.length / PAGE_SIZE));
          page = Math.min(page, pageCount - 1);
          const counts = taskCounts(state);
          const view: UiView = {
            kind: 'view', hint: TASKS_HINT, id: `${id}-list`, revision, title: `Tasks — ${filter}, page ${page + 1}/${pageCount}, ${tasks.length} matches (r${graphRevision})`,
            fallback: `${counts.total} tasks: ${counts.pending} pending, ${counts.ready} ready, ${counts.active} active, ${counts.blocked} blocked, ${counts.completed} completed, ${counts.cancelled} cancelled.`,
            fields: [
              { id: 'id', label: 'Task ID', valueKind: 'text' },
              { id: 'title', label: 'Title', valueKind: 'text' }, { id: 'priority', label: 'Priority', valueKind: 'number' },
              ...['status', 'availability', 'owner', 'blockedBy', 'blockedReason', 'createdAt', 'updatedAt', 'claimedAt', 'completedAt'].map(key => ({ id: key, label: key, valueKind: 'text' as const })),
            ],
            items: tasks.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(task => ({
              id: task.id, fallback: `${task.id}, ${taskAvailability(task, state)}, priority ${task.priority}.`,
              values: { id: task.id, title: plain(task.title), priority: task.priority, status: task.status, availability: taskAvailability(task, state),
                owner: plain(task.ownerSessionId ?? ''), blockedBy: task.blockedBy.join(', '), blockedReason: plain(task.blockedReason ?? ''),
                createdAt: plain(task.createdAt), updatedAt: plain(task.updatedAt), claimedAt: plain(task.claimedAt ?? ''), completedAt: plain(task.completedAt ?? '') },
            })),
            actions: [
              action('filter', 'Filter tasks', [
                { id: 'filter', label: 'Task view', kind: 'enum', required: true, options: TASK_VIEW_VALUES.map(value => ({ id: value, label: value })) },
                field('search', 'Search task IDs and titles', 500),
              ]),
              { id: 'detail', label: 'View task details', target: 'item', outcome: 'submit' },
              ...(page > 0 ? [action('previous', 'Previous page')] : []),
              ...(page + 1 < pageCount ? [action('next', 'Next page')] : []),
              ...(mutations ? [action('create', 'Create task', createFields)] : []), action('refresh', 'Refresh'), closeAction,
            ],
            query: { actionId: 'filter', values: { filter, search } },
            ...((page > 0 || page + 1 < pageCount) ? { paging: {
              ...(page > 0 ? { previousActionId: 'previous' } : {}), ...(page + 1 < pageCount ? { nextActionId: 'next' } : {}),
            } } : {}),
          };
          current = view;
        }
        if (encoder.encode(JSON.stringify(current)).length > (current.kind === 'document' ? 256 * 1024 : 12 * 1024 * 1024)) {
          throw new Error('Task presentation exceeds the protocol byte limit; no task content was omitted.');
        }
        try {
          if (handle && handleKind !== current.kind) {
            const previous = handle; handle = undefined;
            await previous.close();
            if (closing) return;
            handle = await ui.present(current, { signal, onAction });
            handleKind = current.kind;
            if (closing) await close();
          } else await handle?.update(current);
        } catch (error) { fail(error); throw error; }
      };
      const onAction: NonNullable<UiPresentOptions['onAction']> = (request, context) => enqueue(async () => {
            if (closing) throw new Error('Task presentation is closed.');
            const operationSignal = AbortSignal.any([signal, context.signal]);
            operationSignal.throwIfAborted();
            validateAction(current, request);
            if (request.actionId === 'close') { await close(); return; }
            const snapshot = await source.snapshot();
            operationSignal.throwIfAborted();
            if (snapshot.revision !== graphRevision) {
              await render(snapshot);
              throw new Error('Task state changed. Review the refreshed view before retrying the action.');
            }
            if (request.actionId === 'detail' || request.actionId === 'open') {
              const taskId = request.itemId ?? request.values.taskId as string;
              getTask(snapshot, taskId);
              selected = taskId; detailPage = 0;
            } else if (request.actionId === 'back') selected = undefined;
            else if (request.actionId === 'filter') { filter = request.values.filter as TaskView; search = request.values.search as string ?? ''; page = 0; }
            else if (request.actionId === 'next') { if (selected) detailPage++; else page++; }
            else if (request.actionId === 'previous') { if (selected) detailPage--; else page--; }
            else if (request.actionId === 'create') {
              const result = await mutations!.create(createInput(request.values), operationSignal);
              selected = result.task.id; detailPage = 0;
            } else if (request.actionId === 'update') {
              getTask(snapshot, selected!);
              await mutations!.update(updateInput(selected!, request.values), operationSignal);
            }
            if (!closing && !operationSignal.aborted) await render(await source.snapshot());
          });
      signal.addEventListener('abort', abort, { once: true });
      try {
        await render(await source.snapshot());
        signal.throwIfAborted();
        const initial = current!;
        handle = await ui.present(initial, { signal, onAction });
        handleKind = initial.kind;
        if (closing || signal.aborted) await close();
        else {
          await enqueue(async () => { if (!closing && current! !== initial) await render(await source.snapshot()); });
          if (!closing) {
            unsubscribe = source.subscribe(snapshot => {
              void enqueue(async () => { if (!closing && snapshot.revision > graphRevision) await render(snapshot); }).catch(fail);
            });
            await enqueue(async () => { const snapshot = await source.snapshot(); if (!closing && snapshot.revision > graphRevision) await render(snapshot); });
          }
        }
        await closed;
      } finally {
        await close();
        await queue;
        signal.removeEventListener('abort', abort);
      }
      if (failure !== undefined) throw failure;
    },
  };
}

function validateAction(source: UiInteractiveElement, request: UiActionRequest): void {
  if (!request.values || typeof request.values !== 'object' || Array.isArray(request.values)) throw new Error('Invalid task action values.');
  if (request.elementId !== source.id || request.revision !== source.revision) throw new Error('Stale task presentation action.');
  const declared = source.actions.find(candidate => candidate.id === request.actionId);
  if (!declared || request.outcome !== declared.outcome || encoder.encode(JSON.stringify(request)).length > 64 * 1024) throw new Error('Invalid task action.');
  if (declared.target === 'item') {
    if (source.kind !== 'view' || !source.items.some(item => item.id === request.itemId)) throw new Error('Task is not on the current page.');
  } else if (request.itemId !== undefined) throw new Error('Unexpected task action item.');
  const fields = declared.input?.fields ?? [];
  if (Object.keys(request.values).some(key => !fields.some(field => field.id === key))) throw new Error('Unexpected task action field.');
  for (const field of fields) {
    const value = request.values[field.id];
    if (value === undefined) { if (field.required) throw new Error(`Missing task field ${field.id}.`); continue; }
    if (field.kind === 'string' && (typeof value !== 'string' || encoder.encode(value).length > field.maxLength || field.required && !value.trim())
      || field.kind === 'boolean' && typeof value !== 'boolean'
      || field.kind === 'number' && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (field.minimum ?? -Infinity) || value > (field.maximum ?? Infinity))
      || field.kind === 'enum' && (typeof value !== 'string' || !field.options.some(option => option.id === value))) throw new Error(`Invalid task field ${field.id}.`);
  }
}

function optionalText(values: UiValues, key: string): string | undefined {
  const value = values[key] as string | undefined;
  return value?.trim() ? value : undefined;
}
function dependencies(values: UiValues, key: string): string[] | undefined {
  const value = optionalText(values, key);
  if (!value) return undefined;
  const ids = value.trim().split(/[\s,]+/u);
  if (ids.length > 32 || new Set(ids).size !== ids.length || ids.some(id => !TASK_ID_PATTERN.test(id))) throw new Error('Invalid prerequisite task IDs.');
  return ids;
}
function createInput(values: UiValues): CreateTaskInput {
  return { title: values.title as string,
    ...(optionalText(values, 'description') ? { description: values.description as string } : {}),
    ...(optionalText(values, 'acceptanceCriteria') ? { acceptanceCriteria: values.acceptanceCriteria as string } : {}),
    ...(values.priority !== undefined ? { priority: values.priority as number } : {}),
    ...(dependencies(values, 'blockedBy') ? { blockedBy: dependencies(values, 'blockedBy')! } : {}),
  };
}
function updateInput(taskId: string, values: UiValues): UpdateTaskInput {
  const textFields = ['title', 'description', 'acceptanceCriteria', 'notes', 'result', 'blockedReason'] as const;
  return { taskId,
    ...Object.fromEntries(textFields.flatMap(key => optionalText(values, key) ? [[key, values[key]]] : [])),
    ...(values.priority !== undefined ? { priority: values.priority as number } : {}),
    ...(values.status !== undefined ? { status: values.status as NonNullable<UpdateTaskInput['status']> } : {}),
    ...(values.force !== undefined ? { force: values.force as boolean } : {}),
    ...(dependencies(values, 'addBlockedBy') ? { addBlockedBy: dependencies(values, 'addBlockedBy')! } : {}),
    ...(dependencies(values, 'removeBlockedBy') ? { removeBlockedBy: dependencies(values, 'removeBlockedBy')! } : {}),
  };
}

function taskDocument(state: TaskState, task: Task): string {
  const related = (entry: Task) => `${entry.id}: ${markdown(entry.title)} (${taskAvailability(entry, state)})`;
  return [
    `# ${task.id}`, markdown(task.title), '', `Status: ${task.status}`, `Availability: ${taskAvailability(task, state)}`, `Priority: ${task.priority}`,
    `Owner: ${markdown(task.ownerSessionId ?? 'none')}`, `Claimed: ${markdown(task.claimedAt ?? 'never')}`,
    `Created: ${markdown(task.createdAt)}`, `Updated: ${markdown(task.updatedAt)}`, `Completed: ${markdown(task.completedAt ?? 'never')}`,
    '', '## Prerequisites', ...task.blockedBy.map(id => related(getTask(state, id))),
    '', '## Dependents', ...taskDependents(state, task.id).map(related),
    ...(['description', 'acceptanceCriteria', 'blockedReason', 'notes', 'result'] as const).flatMap(key => ['', `## ${key}`, markdown(task[key] ?? 'Not supplied')]),
  ].join('\n');
}
function documentPages(document: string): string[] {
  const pages: string[] = []; let page = '';
  for (const line of document.split('\n')) {
    if (encoder.encode(line).length > 128 * 1024) throw new Error('Task detail line exceeds the presentation byte limit.');
    if (page && encoder.encode(`${page}\n${line}`).length > 128 * 1024) { pages.push(page); page = ''; }
    page = page ? `${page}\n${line}` : line;
  }
  pages.push(page || 'No task details.');
  return pages;
}
function plain(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
function markdown(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .replace(/[\\`*_{}()#+.!|~-]/gu, '\\$&')
    .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/\[/gu, '&#91;').replace(/\]/gu, '&#93;');
}

export { TASKS_HINT } from './data.js';
