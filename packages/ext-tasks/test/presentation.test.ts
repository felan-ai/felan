import { describe, expect, it } from 'vitest';
import { createTask, emptyTaskState, updateTask } from '../src/graph.js';
import { formatTaskDetails, formatTaskLine, taskGraphLayers } from '../src/presentation.js';

const now = '2026-01-01T00:00:00.000Z';

describe('task presentation', () => {
  it('shows dependency titles, availability, and both relationship directions', () => {
    let state = createTask(emptyTaskState(), { title: 'Foundation' }, 'T-AAAAAA', now).state;
    state = createTask(state, { title: 'Dependent', blockedBy: ['T-AAAAAA'] }, 'T-BBBBBB', now).state;

    const details = formatTaskDetails(state, state.tasks[0]!);
    expect(details).toContain('Depends on (0):');
    expect(details).toContain('Unblocks (1):');
    expect(details).toContain('T-BBBBBB · waiting · Dependent');
    expect(formatTaskDetails(state, state.tasks[1]!)).toContain('T-AAAAAA · ready · Foundation');
    expect(formatTaskLine(state.tasks[1]!, state)).toContain('waiting on T-AAAAAA');
  });

  it('shows completed prerequisites as ready dependency context', () => {
    let state = createTask(emptyTaskState(), { title: 'Foundation' }, 'T-AAAAAA', now).state;
    state = createTask(state, { title: 'Dependent', blockedBy: ['T-AAAAAA'] }, 'T-BBBBBB', now).state;
    state = updateTask(state, { taskId: 'T-AAAAAA', status: 'in_progress' }, 'worker', now).state;
    state = updateTask(state, { taskId: 'T-AAAAAA', status: 'completed', result: 'Verified' }, 'worker', now).state;

    expect(formatTaskDetails(state, state.tasks[1]!)).toContain('T-AAAAAA · completed · Foundation');
    expect(taskGraphLayers(state).map((layer) => layer.map((task) => task.id))).toEqual([
      ['T-AAAAAA'],
      ['T-BBBBBB'],
    ]);
  });
});
