import type { UiValues } from '@felan-ai/agent-core';
import type { Task, TaskState } from './contracts.js';
import { getTask, taskAvailability, taskDependents, TASK_ID_PATTERN } from './graph.js';

const fields = ['id', 'title', 'status', 'availability', 'priority', 'ownerSessionId', 'description', 'acceptanceCriteria', 'blockedReason', 'notes', 'result', 'createdAt', 'updatedAt', 'completedAt'] as const;
export type TaskDetailRecord = { field: typeof fields[number]; value: string }
  | { relation: 'prerequisite' | 'dependent'; id: string; title: string; availability: string };

export function taskDetailRecords(state: TaskState, task: Task): TaskDetailRecord[] {
  const values = { ...task, availability: taskAvailability(task, state), priority: String(task.priority) };
  const relation = (entry: Task, kind: 'prerequisite' | 'dependent'): TaskDetailRecord => ({ relation: kind,
    id: entry.id, title: entry.title, availability: taskAvailability(entry, state) });
  return [...fields.map(field => ({ field, value: String(values[field] ?? '') })),
    ...task.blockedBy.map(id => relation(getTask(state, id), 'prerequisite')),
    ...taskDependents(state, task.id).map(entry => relation(entry, 'dependent'))];
}

export function taskDetailDataPages(state: TaskState, task: Task): { data: UiValues; records: TaskDetailRecord[] }[] {
  const encode = (records: TaskDetailRecord[]): UiValues => ({ taskId: task.id,
    prerequisites: task.blockedBy.length, dependents: taskDependents(state, task.id).length,
    ...Object.fromEntries((JSON.stringify(records).match(/[\s\S]{1,4000}/gu) ?? []).map((chunk, i) => [`records${i}`, chunk])),
  });
  const pages: { data: UiValues; records: TaskDetailRecord[] }[] = [];
  let records: TaskDetailRecord[] = [];
  for (const record of taskDetailRecords(state, task)) {
    const next = [...records, record];
    if (new TextEncoder().encode(JSON.stringify(encode(next))).length > 60 * 1024) {
      if (!records.length) throw new Error('Task detail record exceeds the presentation byte limit.');
      pages.push({ data: encode(records), records }); records = [record];
    } else records = next;
  }
  pages.push({ data: encode(records), records });
  return pages;
}

export function readTaskDetailData(data: UiValues | undefined): { taskId: string; prerequisites: number; dependents: number; records: TaskDetailRecord[] } {
  if (!data || typeof data.taskId !== 'string' || !TASK_ID_PATTERN.test(data.taskId)
    || !Number.isSafeInteger(data.prerequisites) || (data.prerequisites as number) < 0
    || !Number.isSafeInteger(data.dependents) || (data.dependents as number) < 0) throw new Error('Invalid task detail data.');
  const chunks = Object.keys(data).filter(key => /^records\d+$/u.test(key)).sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
  const raw: unknown = JSON.parse(chunks.map((key, index) => {
    if (key !== `records${index}` || typeof data[key] !== 'string') throw new Error('Invalid task detail data.');
    return data[key];
  }).join(''));
  if (!Array.isArray(raw) || raw.some(record => !record || typeof record !== 'object'
    || ('field' in record ? !fields.includes(record.field) || typeof record.value !== 'string'
      : !['prerequisite', 'dependent'].includes(record.relation) || typeof record.id !== 'string' || !TASK_ID_PATTERN.test(record.id)
        || typeof record.title !== 'string' || typeof record.availability !== 'string'))) throw new Error('Invalid task detail data.');
  return { taskId: data.taskId, prerequisites: data.prerequisites as number, dependents: data.dependents as number, records: raw as TaskDetailRecord[] };
}
