import { expect, it } from 'vitest';
import { parseSchema, UiValuesSchema } from '../../session-protocol/src/index.js';
import { readTaskDetailData, taskDetailDataPages, taskDetailRecords } from '../src/detail-data.js';
import { createTask, emptyTaskState } from '../src/graph.js';

it('pages semantic fields and relationships without losing Unicode or multiline content', () => {
  let state = createTask(emptyTaskState(), { title: 'Parent', description: '🙂'.repeat(2000) }, 'T-AAAAAA', '2026').state;
  state = { ...state, tasks: [{ ...state.tasks[0]!, notes: '\u0001'.repeat(8000) }] };
  for (let i = 0; i < 30; i++) state = createTask(state, { title: 'x'.repeat(7900), blockedBy: ['T-AAAAAA'] }, `T-${i.toString().padStart(6, '0')}`, '2026').state;
  const task = state.tasks[0]!;
  const pages = taskDetailDataPages(state, task);
  expect(pages.length).toBeGreaterThan(1);
  expect(pages.flatMap(page => {
    expect(() => parseSchema(UiValuesSchema, page.data)).not.toThrow();
    expect(new TextEncoder().encode(JSON.stringify(page.data)).length).toBeLessThanOrEqual(60 * 1024);
    return readTaskDetailData(page.data).records;
  })).toEqual(taskDetailRecords(state, task));
});

it('rejects malformed detail records and missing chunks', () => {
  const data = { taskId: 'T-AAAAAA', prerequisites: 0, dependents: 0 };
  for (const invalid of [undefined, { ...data, records1: '[]' }, { ...data, records0: '[{"field":"unknown","value":"bad"}]' },
    { ...data, records0: '[{"relation":"dependent","id":"unsafe","title":"bad","availability":"ready"}]' }]) {
    expect(() => readTaskDetailData(invalid)).toThrow();
  }
});
