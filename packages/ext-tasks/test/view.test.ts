import { describe, expect, it } from 'vitest';
import type { TaskState } from '../src/contracts.js';
import { assembleTaskView, createTaskViewPublication, MAX_TASK_VIEW_PAGES, parseTaskViewAction, parseTaskViewFrame, parseTaskViewRequest, TASK_VIEW_PAGE_BYTES } from '../src/view.js';

function state(count = 2): TaskState {
  return { schemaVersion: 1, revision: 5, tasks: Array.from({ length: count }, (_, index) => ({
    id: `T-${index.toString(36).toUpperCase().padStart(6, '0')}`, title: 'Repeated title', priority: 2, status: 'completed' as const,
    blockedBy: index ? [`T-${(index - 1).toString(36).toUpperCase().padStart(6, '0')}`] : [],
    createdAt: '2026-01-01', updatedAt: '2026-01-02', completedAt: '2026-01-02',
    result: '🦙'.repeat(4000), notes: '"'.repeat(8000), description: 'Context '.repeat(500), acceptanceCriteria: 'Verified',
  })) };
}
const request = { viewId: 'view', displayMode: 'inline' as const };

describe('task view publications', () => {
  it('transfers a maximum graph and selected details without sending every heavy field', () => {
    const input = state(200); const selectedTaskId = input.tasks[199]!.id;
    const publication = createTaskViewPublication(input, { ...request, selectedTaskId }, 10);
    expect(publication.pages.length).toBeLessThanOrEqual(MAX_TASK_VIEW_PAGES);
    for (const page of publication.pages) expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(TASK_VIEW_PAGE_BYTES);
    const result = assembleTaskView([publication.manifest, ...publication.pages].reverse(), 'view')!;
    expect(result.state.tasks).toHaveLength(200);
    expect(result.state.tasks[0]!.result).toBeUndefined();
    expect(result.state.tasks[199]).toEqual(input.tasks[199]);
    expect(input.tasks[0]!.result).toHaveLength(8000);
  });

  it('waits for a coherent publication and rejects duplicated or foreign pages', () => {
    const publication = createTaskViewPublication(state(), { ...request, selectedTaskId: 'T-000001' }, 2);
    expect(assembleTaskView([publication.manifest, ...publication.pages.slice(1)], 'view')).toBeUndefined();
    expect(assembleTaskView([publication.manifest, ...publication.pages.map(page => ({ ...page, sequence: 1 }))], 'view')).toBeUndefined();
    expect(() => assembleTaskView([publication.manifest, ...publication.pages, publication.pages[0]], 'view')).toThrow();
    expect(() => assembleTaskView([{ ...publication.manifest, viewId: 'foreign' }, ...publication.pages], 'view')).toThrow();
  });

  it('rejects cycles, invalid ownership and details for a different task', () => {
    const publication = createTaskViewPublication(state(), { ...request, selectedTaskId: 'T-000001' }, 2);
    const cyclic = structuredClone(publication);
    if (cyclic.pages[0]?.kind !== 'summary') throw new Error('Expected summary');
    cyclic.pages[0].tasks[0] = { ...cyclic.pages[0].tasks[0]!, blockedBy: ['T-000001'] };
    expect(() => assembleTaskView([cyclic.manifest, ...cyclic.pages], 'view')).toThrow();
    const foreign = structuredClone(publication);
    const detail = foreign.pages.find(page => page.kind === 'detail')!;
    if (detail.kind === 'detail') detail.taskId = 'T-000000';
    expect(() => assembleTaskView([foreign.manifest, ...foreign.pages], 'view')).toThrow();
    const invalid = { kind: 'summary', viewId: 'view', sequence: 0, index: 0, tasks: [{ ...state().tasks[0], status: 'in_progress' }] };
    expect(() => parseTaskViewFrame(invalid)).toThrow();
  });

  it('validates navigation and rejects oversized or malformed frames', () => {
    expect(parseTaskViewAction({ action: 'detail', taskId: 'T-000001' })).toEqual({ action: 'detail', taskId: 'T-000001' });
    for (const value of [{ action: 'delete', taskId: 'T-000001' }, { action: 'close', extra: true }, { action: 'detail', taskId: '../x' }]) {
      expect(() => parseTaskViewAction(value)).toThrow();
    }
    expect(() => parseTaskViewRequest({ ...request, displayMode: ['inline'] })).toThrow();
    expect(() => createTaskViewPublication(state(), request, Number.MAX_SAFE_INTEGER + 1)).toThrow();
    expect(() => parseTaskViewFrame({ kind: 'detail', viewId: 'view', sequence: 1, index: 0, taskId: 'T-000001', field: 'notes', value: 'x'.repeat(TASK_VIEW_PAGE_BYTES) })).toThrow();
    expect(() => createTaskViewPublication(state(), { ...request, selectedTaskId: 'T-999999' }, 1)).toThrow();
  });
});
