import type { Task, TaskState } from './contracts.js';
import { MAX_DEPENDENCIES, MAX_TASKS, parseTaskState, TASK_ID_PATTERN } from './graph.js';

export const TASKS_PRESENTER = Object.freeze({ id: 'felan.tasks', version: '1' });
export const TASK_VIEW_PAGE_BYTES = 60 * 1024;
export const MAX_TASK_VIEW_PAGES = 64;
const detailFields = ['description', 'acceptanceCriteria', 'notes', 'result'] as const;
type DetailField = typeof detailFields[number];
type Summary = Omit<Task, DetailField>;
export type TaskViewAction = { action: 'close' } | { action: 'detail'; taskId: string };
export interface TaskViewRequest { viewId: string; displayMode: 'inline' | 'overlay'; selectedTaskId?: string }
export interface TaskViewManifest {
  kind: 'manifest'; viewId: string; sequence: number; revision: number; pages: number; selectedTaskId?: string;
  detailFields: DetailField[];
}
export type TaskViewPage = { kind: 'summary'; viewId: string; sequence: number; index: number; tasks: Summary[] }
  | { kind: 'detail'; viewId: string; sequence: number; index: number; taskId: string; field: DetailField; value: string };
export type TaskViewFrame = TaskViewManifest | TaskViewPage;
export interface TaskViewPublication { manifest: TaskViewManifest; pages: TaskViewPage[] }

function invalid(): never { throw new Error('Invalid task presentation data.'); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: readonly string[]): void { if (Object.keys(value).some(key => !keys.includes(key))) invalid(); }
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum; }
function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}
function viewId(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/u.test(value); }
function taskId(value: unknown): value is string { return typeof value === 'string' && TASK_ID_PATTERN.test(value); }
function bytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }

export function parseTaskViewRequest(value: unknown): TaskViewRequest {
  if (!record(value) || !viewId(value.viewId) || (value.displayMode !== 'inline' && value.displayMode !== 'overlay')
    || value.selectedTaskId !== undefined && !taskId(value.selectedTaskId)) invalid();
  exact(value, ['viewId', 'displayMode', 'selectedTaskId']);
  return { viewId: value.viewId, displayMode: value.displayMode as TaskViewRequest['displayMode'],
    ...(value.selectedTaskId === undefined ? {} : { selectedTaskId: value.selectedTaskId as string }) };
}

export function parseTaskViewAction(value: unknown): TaskViewAction {
  if (!record(value)) invalid();
  if (value.action === 'close') { exact(value, ['action']); return { action: 'close' }; }
  if (value.action !== 'detail' || !taskId(value.taskId)) invalid();
  exact(value, ['action', 'taskId']); return { action: 'detail', taskId: value.taskId };
}

export function createTaskViewPublication(state: TaskState, request: TaskViewRequest, sequence: number): TaskViewPublication {
  const normalized = parseTaskState(state);
  const selection = parseTaskViewRequest(request);
  if (!integer(sequence)) invalid();
  const selected = selection.selectedTaskId === undefined ? undefined : normalized.tasks.find(task => task.id === selection.selectedTaskId);
  if (selection.selectedTaskId && !selected) invalid();
  const pages: TaskViewPage[] = [];
  let page: Extract<TaskViewPage, { kind: 'summary' }> = { kind: 'summary', viewId: request.viewId, sequence, index: 0, tasks: [] };
  for (const task of normalized.tasks) {
    const { description: _description, acceptanceCriteria: _criteria, notes: _notes, result: _result, ...summary } = task;
    const next = { ...page, tasks: [...page.tasks, summary] };
    if (bytes(next) > TASK_VIEW_PAGE_BYTES) {
      if (!page.tasks.length) invalid();
      pages.push(page);
      page = { kind: 'summary', viewId: request.viewId, sequence, index: pages.length, tasks: [summary] };
      if (bytes(page) > TASK_VIEW_PAGE_BYTES) invalid();
    } else page = next;
  }
  pages.push(page);
  const selectedFields: DetailField[] = [];
  for (const field of detailFields) {
    const value = selected?.[field];
    if (value === undefined) continue;
    selectedFields.push(field);
    pages.push({ kind: 'detail', viewId: request.viewId, sequence, index: pages.length, taskId: selected!.id, field, value });
  }
  if (pages.length > MAX_TASK_VIEW_PAGES || pages.some(entry => bytes(entry) > TASK_VIEW_PAGE_BYTES)) invalid();
  const manifest: TaskViewManifest = { kind: 'manifest', viewId: request.viewId, sequence, revision: normalized.revision,
    pages: pages.length, detailFields: selectedFields, ...(selected ? { selectedTaskId: selected.id } : {}) };
  pages.forEach(parseTaskViewFrame);
  parseTaskViewFrame(manifest);
  return { manifest, pages };
}

function parseSummary(value: unknown): Summary {
  if (!record(value) || !taskId(value.id) || !text(value.title, 8000) || !integer(value.priority, 4)
    || typeof value.status !== 'string' || !['pending', 'in_progress', 'blocked', 'completed', 'cancelled'].includes(value.status)
    || !text(value.createdAt, 256) || !text(value.updatedAt, 256) || !Array.isArray(value.blockedBy)
    || value.blockedBy.length > MAX_DEPENDENCIES || !value.blockedBy.every(taskId)
    || new Set(value.blockedBy).size !== value.blockedBy.length) invalid();
  exact(value, ['id', 'title', 'priority', 'status', 'blockedBy', 'createdAt', 'updatedAt', 'ownerSessionId', 'claimedAt', 'completedAt', 'blockedReason']);
  for (const key of ['ownerSessionId', 'claimedAt', 'completedAt', 'blockedReason'] as const) {
    if (value[key] !== undefined && !text(value[key], key === 'blockedReason' ? 8000 : 256)) invalid();
  }
  if ((value.status === 'in_progress') !== (value.ownerSessionId !== undefined && value.claimedAt !== undefined)
    || value.status !== 'in_progress' && (value.ownerSessionId !== undefined || value.claimedAt !== undefined)
    || (value.status === 'completed') !== (value.completedAt !== undefined)
    || (value.status === 'blocked') !== (value.blockedReason !== undefined)) invalid();
  return { ...value, blockedBy: [...value.blockedBy] } as unknown as Summary;
}

export function parseTaskViewFrame(value: unknown): TaskViewFrame {
  if (!record(value) || !viewId(value.viewId) || !integer(value.sequence) || bytes(value) > TASK_VIEW_PAGE_BYTES) invalid();
  if (value.kind === 'manifest') {
    exact(value, ['kind', 'viewId', 'sequence', 'revision', 'pages', 'detailFields', 'selectedTaskId']);
    if (!integer(value.revision) || !integer(value.pages, MAX_TASK_VIEW_PAGES) || !value.pages
      || !Array.isArray(value.detailFields) || value.detailFields.length > detailFields.length
      || !value.detailFields.every(field => detailFields.includes(field)) || new Set(value.detailFields).size !== value.detailFields.length
      || value.selectedTaskId !== undefined && !taskId(value.selectedTaskId)
      || value.selectedTaskId === undefined && value.detailFields.length) invalid();
    return { ...value, detailFields: [...value.detailFields] } as unknown as TaskViewManifest;
  }
  if (!integer(value.index, MAX_TASK_VIEW_PAGES - 1)) invalid();
  if (value.kind === 'summary') {
    exact(value, ['kind', 'viewId', 'sequence', 'index', 'tasks']);
    if (!Array.isArray(value.tasks) || value.tasks.length > MAX_TASKS) invalid();
    return { kind: 'summary', viewId: value.viewId, sequence: value.sequence, index: value.index, tasks: value.tasks.map(parseSummary) };
  }
  exact(value, ['kind', 'viewId', 'sequence', 'index', 'taskId', 'field', 'value']);
  if (value.kind !== 'detail' || !taskId(value.taskId) || !detailFields.includes(value.field as DetailField) || !text(value.value, TASK_VIEW_PAGE_BYTES)) invalid();
  return { kind: 'detail', viewId: value.viewId, sequence: value.sequence, index: value.index, taskId: value.taskId, field: value.field as DetailField, value: value.value };
}

export function assembleTaskView(values: readonly unknown[], id: string): { sequence: number; state: TaskState; selectedTaskId?: string } | undefined {
  if (!viewId(id) || values.length > MAX_TASK_VIEW_PAGES + 1) invalid();
  const frames = values.map(parseTaskViewFrame);
  if (frames.some(frame => frame.viewId !== id)) invalid();
  const manifests = frames.filter((frame): frame is TaskViewManifest => frame.kind === 'manifest');
  if (!manifests.length) return undefined;
  if (manifests.length !== 1) invalid();
  const manifest = manifests[0]!;
  const pages = frames.filter((frame): frame is TaskViewPage => frame.kind !== 'manifest' && frame.sequence === manifest.sequence);
  if (new Set(pages.map(page => page.index)).size !== pages.length || pages.some(page => page.index >= manifest.pages)) invalid();
  if (pages.length < manifest.pages) return undefined;
  const tasks: Task[] = pages.sort((a, b) => a.index - b.index).flatMap(page => page.kind === 'summary' ? page.tasks : []);
  if (tasks.length > MAX_TASKS || new Set(tasks.map(task => task.id)).size !== tasks.length) invalid();
  const byId = new Map(tasks.map(task => [task.id, task]));
  const seen = new Set<string>(); const visiting = new Set<string>();
  const visit = (task: Task) => {
    if (visiting.has(task.id)) invalid();
    if (seen.has(task.id)) return;
    visiting.add(task.id);
    for (const dependency of task.blockedBy) {
      const parent = byId.get(dependency);
      if (!parent || (task.status === 'in_progress' || task.status === 'completed') && parent.status !== 'completed') invalid();
      visit(parent);
    }
    visiting.delete(task.id); seen.add(task.id);
  };
  tasks.forEach(visit);
  const selected = manifest.selectedTaskId === undefined ? undefined : byId.get(manifest.selectedTaskId);
  if (manifest.selectedTaskId !== undefined && !selected) invalid();
  const details = pages.filter((page): page is Extract<TaskViewPage, { kind: 'detail' }> => page.kind === 'detail');
  if (details.length !== manifest.detailFields.length || new Set(details.map(page => page.field)).size !== details.length) invalid();
  for (const page of details) {
    if (!selected || page.taskId !== selected.id || !manifest.detailFields.includes(page.field)) invalid();
    Object.assign(selected, { [page.field]: page.value });
  }
  if (selected?.status === 'completed' && !selected.result) invalid();
  return { sequence: manifest.sequence, state: { schemaVersion: 1, revision: manifest.revision, tasks },
    ...(selected ? { selectedTaskId: selected.id } : {}) };
}
