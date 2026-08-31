import type { Task, TaskState, TaskView } from './contracts.js';
import {
  incompleteBlockers,
  listTasks,
  taskAvailability,
  taskCounts,
  taskDependents,
} from './graph.js';

export function formatTaskSummary(state: TaskState): string {
  const counts = taskCounts(state);
  if (counts.total === 0) return 'No session tasks.';
  return `Tasks r${state.revision}: ${counts.completed}/${counts.total} completed · ${counts.active} active · ${counts.ready} ready · ${counts.blocked} blocked`;
}

export function formatTaskList(
  state: TaskState,
  tasks: readonly Task[],
  view: TaskView,
  limit = 50,
): string {
  const selected = tasks.slice(0, limit);
  const lines = [formatTaskSummary(state), `View: ${view}`];
  if (selected.length === 0) return [...lines, 'No matching tasks.'].join('\n');
  lines.push('');
  for (const task of selected) lines.push(formatTaskLine(task, state));
  if (tasks.length > selected.length) lines.push(`… ${tasks.length - selected.length} more`);
  return lines.join('\n');
}

export function formatTaskDetails(state: TaskState, task: Task): string {
  const availability = taskAvailability(task, state);
  const prerequisites = task.blockedBy.map((id) => relatedTask(state, id));
  const dependents = taskDependents(state, task.id).map((entry) => relatedTask(state, entry.id));
  return [
    `Task ${task.id}`,
    task.title,
    '',
    'Lifecycle',
    `  Status: ${task.status}`,
    `  Availability: ${availability}`,
    `  Priority: P${task.priority}`,
    '',
    'Execution',
    `  Owner: ${task.ownerSessionId ?? '-'}`,
    '',
    'Dependencies',
    `  Depends on (${prerequisites.length}):`,
    ...(prerequisites.length > 0 ? prerequisites.map((entry) => `    - ${entry}`) : ['    - None']),
    `  Unblocks (${dependents.length}):`,
    ...(dependents.length > 0 ? dependents.map((entry) => `    - ${entry}`) : ['    - None']),
    '',
    'Work context',
    ...formatMultilineField('Description', task.description),
    ...formatMultilineField('Acceptance criteria', task.acceptanceCriteria),
    ...formatMultilineField('Blocked reason', task.blockedReason),
    ...formatMultilineField('Notes', task.notes),
    ...formatMultilineField('Result', task.result),
    '',
    'Timeline',
    `  Created: ${task.createdAt}`,
    `  Updated: ${task.updatedAt}`,
    `  Completed: ${task.completedAt ?? '-'}`,
  ].join('\n');
}

export function formatTaskMutation(action: 'Created' | 'Updated', state: TaskState, task: Task): string {
  return [
    `${action} ${task.id}: ${task.title}`,
    `Status: ${task.status}`,
    `Availability: ${taskAvailability(task, state)}`,
    `Priority: P${task.priority}`,
    `Blocked by: ${task.blockedBy.join(', ') || '-'}`,
    '',
    formatTaskSummary(state),
  ].join('\n');
}

export function formatTaskContext(state: TaskState): string {
  const active = listTasks(state, 'active');
  const ready = listTasks(state, 'ready');
  const blocked = listTasks(state, 'blocked');
  const lines = ['# Session Tasks', formatTaskSummary(state)];
  appendContextGroup(lines, 'Active', active, state);
  appendContextGroup(lines, 'Ready', ready, state);
  appendContextGroup(lines, 'Blocked', blocked, state);
  lines.push('Use TaskList for the current frontier and TaskGet for full task context.');
  return lines.join('\n');
}

export function formatTaskLine(task: Task, state: TaskState): string {
  const availability = taskAvailability(task, state);
  const owner = task.ownerSessionId ? ` @${task.ownerSessionId}` : '';
  const waiting = availability === 'waiting'
    ? ` ← waiting on ${incompleteBlockers(task, state).map((entry) => entry.id).join(',')}`
    : task.blockedReason
      ? ` — ${oneLine(task.blockedReason, 60)}`
      : '';
  return `${task.id} [P${task.priority}] ${availability}${owner}  ${oneLine(task.title, 100)}${waiting}`;
}

export function taskGraphLayers(state: TaskState): Task[][] {
  const byId = new Map(state.tasks.map((task) => [task.id, task]));
  const depths = new Map<string, number>();
  const depth = (task: Task): number => {
    const cached = depths.get(task.id);
    if (cached !== undefined) return cached;
    const value = task.blockedBy.length === 0
      ? 0
      : Math.max(...task.blockedBy.map((id) => depth(byId.get(id)!))) + 1;
    depths.set(task.id, value);
    return value;
  };
  const layers: Task[][] = [];
  for (const task of state.tasks) {
    const index = depth(task);
    const layer = layers[index] ?? [];
    layer.push(task);
    layers[index] = layer;
  }
  for (const layer of layers) layer.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  return layers;
}

function relatedTask(state: TaskState, id: string): string {
  const task = state.tasks.find((entry) => entry.id === id);
  if (!task) return `${id} · missing`;
  return `${task.id} · ${taskAvailability(task, state)} · ${oneLine(task.title, 80)}`;
}

function formatMultilineField(label: string, value: string | undefined): string[] {
  const lines = (value ?? '-').split(/\r?\n/u);
  return [`  ${label}: ${lines[0] ?? ''}`, ...lines.slice(1).map((line) => `    ${line || ' '}`)];
}

function appendContextGroup(lines: string[], label: string, tasks: readonly Task[], state: TaskState): void {
  if (tasks.length === 0) return;
  lines.push(`${label}:`);
  for (const task of tasks.slice(0, 8)) lines.push(`- ${formatTaskLine(task, state)}`);
  if (tasks.length > 8) lines.push(`- … ${tasks.length - 8} more`);
}

function oneLine(value: string, max: number): string {
  const compact = value.replace(/\s+/gu, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}
