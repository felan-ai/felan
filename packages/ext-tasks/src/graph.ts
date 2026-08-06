import type {
  CreateTaskInput,
  Task,
  TaskAvailability,
  TaskCounts,
  TaskMutationResult,
  TaskState,
  TaskStatus,
  TaskView,
  UpdateTaskInput,
} from './contracts.js';
import { TASK_STATUS_VALUES } from './contracts.js';

export const MAX_TASKS = 200;
export const MAX_DEPENDENCIES = 32;
export const TASK_ID_PATTERN = /^T-[A-Z0-9]{6}$/u;

const TASK_STATUSES: ReadonlySet<string> = new Set(TASK_STATUS_VALUES);

export class TaskGraphError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`Task error: ${code} — ${message}`);
    this.name = 'TaskGraphError';
  }
}

export function emptyTaskState(): TaskState {
  return { schemaVersion: 1, revision: 0, tasks: [] };
}

export function cloneTaskState(state: TaskState): TaskState {
  return {
    schemaVersion: 1,
    revision: state.revision,
    tasks: state.tasks.map((task) => ({ ...task, blockedBy: [...task.blockedBy] })),
  };
}

export function createTask(
  state: TaskState,
  input: CreateTaskInput,
  id: string,
  now: string,
): TaskMutationResult {
  if (state.tasks.length >= MAX_TASKS) {
    throw new TaskGraphError('task_limit', `A session task graph may contain at most ${MAX_TASKS} tasks`);
  }
  if (!TASK_ID_PATTERN.test(id)) throw new TaskGraphError('invalid_id', `Invalid task id: ${id}`);
  if (state.tasks.some((task) => task.id === id)) throw new TaskGraphError('duplicate_id', `Task already exists: ${id}`);

  const blockedBy = uniqueIds(input.blockedBy ?? []);
  const task: Task = {
    id,
    title: requiredText(input.title, 'title'),
    priority: priorityValue(input.priority ?? 2),
    status: 'pending',
    blockedBy,
    createdAt: now,
    updatedAt: now,
    ...(input.description === undefined ? {} : { description: requiredText(input.description, 'description') }),
    ...(input.acceptanceCriteria === undefined
      ? {}
      : { acceptanceCriteria: requiredText(input.acceptanceCriteria, 'acceptance criteria') }),
  };
  const tasks = [...state.tasks, task];
  assertGraphValid(tasks);
  return {
    state: { schemaVersion: 1, revision: state.revision + 1, tasks },
    task,
  };
}

export function updateTask(
  state: TaskState,
  input: UpdateTaskInput,
  actorSessionId: string,
  now: string,
): TaskMutationResult {
  const index = state.tasks.findIndex((task) => task.id === input.taskId);
  if (index < 0) throw new TaskGraphError('not_found', `Task not found: ${input.taskId}`);
  const actor = requiredText(actorSessionId, 'session id');
  const original = state.tasks[index]!;
  let task: Task = { ...original, blockedBy: [...original.blockedBy] };

  if (
    original.status === 'in_progress'
    && original.ownerSessionId !== actor
    && input.force !== true
  ) {
    throw new TaskGraphError('not_owner', `${original.id} is claimed by ${original.ownerSessionId}`);
  }

  if (original.status === 'completed' && input.status !== undefined && input.status !== 'completed') {
    const protectedDependents = state.tasks.filter((entry) => (
      entry.blockedBy.includes(original.id)
      && (entry.status === 'in_progress' || entry.status === 'completed')
    ));
    if (protectedDependents.length > 0) {
      throw new TaskGraphError(
        'dependent_started',
        `Reopen dependent tasks before reopening ${original.id}: ${protectedDependents.map((entry) => entry.id).join(', ')}`,
      );
    }
  }

  if (input.title !== undefined) task = { ...task, title: requiredText(input.title, 'title') };
  if (input.description !== undefined) {
    task = { ...task, description: requiredText(input.description, 'description') };
  }
  if (input.acceptanceCriteria !== undefined) {
    task = {
      ...task,
      acceptanceCriteria: requiredText(input.acceptanceCriteria, 'acceptance criteria'),
    };
  }
  if (input.priority !== undefined) task = { ...task, priority: priorityValue(input.priority) };
  if (input.notes !== undefined) task = { ...task, notes: requiredText(input.notes, 'notes') };

  const dependencyChange = input.addBlockedBy !== undefined || input.removeBlockedBy !== undefined;
  if (dependencyChange && isTerminal(original.status) && input.status !== 'pending') {
    throw new TaskGraphError('terminal_task', 'Reopen a completed or cancelled task before changing its dependencies');
  }
  const additions = uniqueIds(input.addBlockedBy ?? []);
  const removals = uniqueIds(input.removeBlockedBy ?? []);
  const overlap = additions.find((id) => removals.includes(id));
  if (overlap) throw new TaskGraphError('dependency_conflict', `${overlap} cannot be added and removed together`);
  const blockedBy = task.blockedBy.filter((id) => !removals.includes(id));
  for (const id of additions) {
    if (!blockedBy.includes(id)) blockedBy.push(id);
  }
  task = { ...task, blockedBy };

  if (input.result !== undefined && input.status !== 'completed' && original.status !== 'completed') {
    throw new TaskGraphError('invalid_result', 'A result can only be written while completing a task');
  }
  if (input.blockedReason !== undefined && input.status !== 'blocked' && original.status !== 'blocked') {
    throw new TaskGraphError('invalid_blocker', 'A blocked reason requires blocked status');
  }

  if (input.status !== undefined) {
    task = transitionTask(state, task, input, actor, now);
  } else {
    if (input.result !== undefined) task = { ...task, result: requiredText(input.result, 'result') };
    if (input.blockedReason !== undefined) {
      task = { ...task, blockedReason: requiredText(input.blockedReason, 'blocked reason') };
    }
  }

  const candidateTasks = state.tasks.map((entry, entryIndex) => entryIndex === index ? task : entry);
  assertGraphValid(candidateTasks);
  if (task.status === 'in_progress' || task.status === 'completed') assertDependenciesCompleted(task, candidateTasks);

  const unchanged = JSON.stringify({ ...task, updatedAt: original.updatedAt }) === JSON.stringify(original);
  if (unchanged) throw new TaskGraphError('no_changes', `No changes were supplied for ${task.id}`);
  task = { ...task, updatedAt: now };
  const tasks = state.tasks.map((entry, entryIndex) => entryIndex === index ? task : entry);
  return {
    state: { schemaVersion: 1, revision: state.revision + 1, tasks },
    task,
  };
}

export function getTask(state: TaskState, id: string): Task {
  const task = state.tasks.find((entry) => entry.id === id);
  if (!task) throw new TaskGraphError('not_found', `Task not found: ${id}`);
  return { ...task, blockedBy: [...task.blockedBy] };
}

export function taskDependents(state: TaskState, id: string): Task[] {
  return state.tasks
    .filter((task) => task.blockedBy.includes(id))
    .map((task) => ({ ...task, blockedBy: [...task.blockedBy] }));
}

export function taskAvailability(task: Task, state: TaskState): TaskAvailability {
  if (task.status === 'in_progress') return 'in_progress';
  if (task.status === 'blocked') return 'blocked';
  if (task.status === 'completed') return 'completed';
  if (task.status === 'cancelled') return 'cancelled';
  return incompleteBlockers(task, state).length === 0 ? 'ready' : 'waiting';
}

export function incompleteBlockers(task: Task, state: TaskState): Task[] {
  const tasks = new Map(state.tasks.map((entry) => [entry.id, entry]));
  return task.blockedBy
    .map((id) => tasks.get(id))
    .filter((entry): entry is Task => entry !== undefined && entry.status !== 'completed');
}

export function listTasks(state: TaskState, view: TaskView): Task[] {
  return state.tasks
    .filter((task) => matchesView(task, state, view))
    .map((task) => ({ ...task, blockedBy: [...task.blockedBy] }))
    .sort((left, right) => compareTasks(left, right, state));
}

export function taskCounts(state: TaskState): TaskCounts {
  const counts = {
    total: state.tasks.length,
    ready: 0,
    active: 0,
    blocked: 0,
    pending: 0,
    completed: 0,
    cancelled: 0,
  };
  for (const task of state.tasks) {
    const availability = taskAvailability(task, state);
    if (availability === 'ready') counts.ready += 1;
    if (availability === 'in_progress') counts.active += 1;
    if (availability === 'blocked' || availability === 'waiting') counts.blocked += 1;
    if (task.status === 'pending') counts.pending += 1;
    if (task.status === 'completed') counts.completed += 1;
    if (task.status === 'cancelled') counts.cancelled += 1;
  }
  return counts;
}

export function hasOpenTasks(state: TaskState): boolean {
  return state.tasks.some((task) => !isTerminal(task.status));
}

export function parseTaskState(value: unknown): TaskState {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isNonNegativeInteger(value.revision)) {
    throw new TaskGraphError('invalid_state', 'Stored task state has an unsupported schema or revision');
  }
  if (!Array.isArray(value.tasks) || value.tasks.length > MAX_TASKS) {
    throw new TaskGraphError('invalid_state', 'Stored task state has an invalid task collection');
  }
  const state: TaskState = {
    schemaVersion: 1,
    revision: value.revision,
    tasks: value.tasks.map(parseTask),
  };
  assertGraphValid(state.tasks);
  for (const task of state.tasks) {
    if (task.status === 'in_progress' || task.status === 'completed') {
      assertDependenciesCompleted(task, state.tasks);
    }
  }
  return state;
}

function transitionTask(
  state: TaskState,
  task: Task,
  input: UpdateTaskInput,
  actor: string,
  now: string,
): Task {
  const status = input.status!;
  if (status === 'in_progress') {
    if (task.status !== 'pending' && task.status !== 'in_progress') {
      throw new TaskGraphError('not_ready', `${task.id} must be pending before it can be claimed`);
    }
    const active = state.tasks.find((entry) => (
      entry.status === 'in_progress'
      && entry.ownerSessionId === actor
      && entry.id !== task.id
    ));
    if (active) throw new TaskGraphError('actor_busy', `${actor} already owns ${active.id}`);
    assertDependenciesCompleted(task, state.tasks);
    const base = clearTerminalFields(clearBlockedFields(task));
    return {
      ...base,
      status: 'in_progress',
      ownerSessionId: actor,
      claimedAt: task.ownerSessionId === actor && task.claimedAt ? task.claimedAt : now,
    };
  }

  if (status === 'pending') {
    return { ...clearOwnership(clearTerminalFields(clearBlockedFields(task))), status: 'pending' };
  }

  if (status === 'blocked') {
    const reason = input.blockedReason ?? task.blockedReason;
    if (!reason) throw new TaskGraphError('blocked_reason_required', 'Blocked tasks require a blocked reason');
    return {
      ...clearOwnership(clearTerminalFields(task)),
      status: 'blocked',
      blockedReason: requiredText(reason, 'blocked reason'),
    };
  }

  if (status === 'completed') {
    if (task.status !== 'in_progress' && task.status !== 'completed') {
      throw new TaskGraphError('claim_required', `${task.id} must be claimed before completion`);
    }
    const result = input.result ?? task.result;
    if (!result) throw new TaskGraphError('result_required', 'Completed tasks require a result');
    assertDependenciesCompleted(task, state.tasks);
    return {
      ...clearOwnership(clearBlockedFields(task)),
      status: 'completed',
      result: requiredText(result, 'result'),
      completedAt: task.completedAt ?? now,
    };
  }

  return { ...clearOwnership(clearTerminalFields(clearBlockedFields(task))), status: 'cancelled' };
}

function clearOwnership(task: Task): Task {
  const { ownerSessionId: _owner, claimedAt: _claimed, ...rest } = task;
  return rest;
}

function clearBlockedFields(task: Task): Task {
  const { blockedReason: _reason, ...rest } = task;
  return rest;
}

function clearTerminalFields(task: Task): Task {
  const { result: _result, completedAt: _completed, ...rest } = task;
  return rest;
}

function assertDependenciesCompleted(task: Task, tasks: readonly Task[]): void {
  const byId = new Map(tasks.map((entry) => [entry.id, entry]));
  const incomplete = task.blockedBy.filter((id) => byId.get(id)?.status !== 'completed');
  if (incomplete.length > 0) {
    throw new TaskGraphError('blocked', `${task.id} is waiting on ${incomplete.join(', ')}`);
  }
}

function assertGraphValid(tasks: readonly Task[]): void {
  const byId = new Map<string, Task>();
  for (const task of tasks) {
    if (byId.has(task.id)) throw new TaskGraphError('invalid_state', `Duplicate task id: ${task.id}`);
    byId.set(task.id, task);
  }
  for (const task of tasks) {
    if (task.blockedBy.length > MAX_DEPENDENCIES) {
      throw new TaskGraphError('dependency_limit', `${task.id} has more than ${MAX_DEPENDENCIES} prerequisites`);
    }
    for (const blocker of task.blockedBy) {
      if (blocker === task.id) throw new TaskGraphError('self_dependency', `${task.id} cannot block itself`);
      if (!byId.has(blocker)) throw new TaskGraphError('unknown_dependency', `Task not found: ${blocker}`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      throw new TaskGraphError('dependency_cycle', [...path.slice(start), id].join(' -> '));
    }
    visiting.add(id);
    path.push(id);
    for (const blocker of byId.get(id)!.blockedBy) visit(blocker);
    path.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

function matchesView(task: Task, state: TaskState, view: TaskView): boolean {
  const availability = taskAvailability(task, state);
  if (view === 'all') return true;
  if (view === 'current') return !isTerminal(task.status);
  if (view === 'ready') return availability === 'ready';
  if (view === 'active') return task.status === 'in_progress';
  if (view === 'blocked') return availability === 'blocked' || availability === 'waiting';
  if (view === 'pending') return task.status === 'pending';
  return task.status === 'completed';
}

function compareTasks(left: Task, right: Task, state: TaskState): number {
  const rank = (task: Task): number => {
    const availability = taskAvailability(task, state);
    return availability === 'in_progress' ? 0
      : availability === 'ready' ? 1
        : availability === 'blocked' || availability === 'waiting' ? 2
          : availability === 'completed' ? 3
            : 4;
  };
  return rank(left) - rank(right)
    || left.priority - right.priority
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id);
}

function parseTask(value: unknown): Task {
  if (!isRecord(value) || typeof value.id !== 'string' || !TASK_ID_PATTERN.test(value.id)) {
    throw new TaskGraphError('invalid_state', 'Stored task has an invalid id');
  }
  if (typeof value.title !== 'string' || !TASK_STATUSES.has(String(value.status))) {
    throw new TaskGraphError('invalid_state', `Stored task ${value.id} has invalid required fields`);
  }
  if (!Array.isArray(value.blockedBy) || !value.blockedBy.every((id) => typeof id === 'string')) {
    throw new TaskGraphError('invalid_state', `Stored task ${value.id} has invalid dependencies`);
  }
  const task: Task = {
    id: value.id,
    title: requiredText(value.title, 'title'),
    priority: priorityValue(value.priority),
    status: value.status as TaskStatus,
    blockedBy: uniqueIds(value.blockedBy),
    createdAt: storedText(value.createdAt, value.id, 'createdAt'),
    updatedAt: storedText(value.updatedAt, value.id, 'updatedAt'),
    ...optionalStoredText(value, 'description'),
    ...optionalStoredText(value, 'acceptanceCriteria'),
    ...optionalStoredText(value, 'ownerSessionId'),
    ...optionalStoredText(value, 'claimedAt'),
    ...optionalStoredText(value, 'notes'),
    ...optionalStoredText(value, 'result'),
    ...optionalStoredText(value, 'blockedReason'),
    ...optionalStoredText(value, 'completedAt'),
  };
  if (task.status === 'in_progress' && (!task.ownerSessionId || !task.claimedAt)) {
    throw new TaskGraphError('invalid_state', `Stored active task ${task.id} has no owner`);
  }
  if (task.status !== 'in_progress' && (task.ownerSessionId || task.claimedAt)) {
    throw new TaskGraphError('invalid_state', `Stored inactive task ${task.id} has active ownership`);
  }
  if (task.status === 'blocked' && !task.blockedReason) {
    throw new TaskGraphError('invalid_state', `Stored blocked task ${task.id} has no reason`);
  }
  if (task.status !== 'blocked' && task.blockedReason) {
    throw new TaskGraphError('invalid_state', `Stored task ${task.id} has a stale blocked reason`);
  }
  if (task.status === 'completed' && (!task.result || !task.completedAt)) {
    throw new TaskGraphError('invalid_state', `Stored completed task ${task.id} has no result`);
  }
  if (task.status !== 'completed' && (task.result || task.completedAt)) {
    throw new TaskGraphError('invalid_state', `Stored task ${task.id} has stale completion data`);
  }
  return task;
}

function optionalStoredText<K extends keyof Task>(
  value: Record<string, unknown>,
  key: K,
): Partial<Pick<Task, K>> {
  const entry = value[key];
  if (entry === undefined) return {};
  if (typeof entry !== 'string' || entry.trim().length === 0) {
    throw new TaskGraphError('invalid_state', `Stored task has invalid ${String(key)}`);
  }
  return { [key]: entry } as Partial<Pick<Task, K>>;
}

function storedText(value: unknown, id: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TaskGraphError('invalid_state', `Stored task ${id} has invalid ${field}`);
  }
  return value;
}

function requiredText(value: string, field: string): string {
  const text = value.trim();
  if (!text) throw new TaskGraphError('invalid_request', `${field} cannot be empty`);
  return text;
}

function priorityValue(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 4) {
    throw new TaskGraphError('invalid_priority', 'Priority must be an integer from 0 to 4');
  }
  return value as number;
}

function uniqueIds(ids: readonly string[]): string[] {
  const unique = [...new Set(ids.map((id) => id.trim()))];
  if (unique.some((id) => !TASK_ID_PATTERN.test(id))) {
    throw new TaskGraphError('invalid_id', 'Dependency IDs must use the task ID returned by TaskCreate');
  }
  if (unique.length > MAX_DEPENDENCIES) {
    throw new TaskGraphError('dependency_limit', `A task may have at most ${MAX_DEPENDENCIES} prerequisites`);
  }
  return unique;
}

function isTerminal(status: TaskStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
