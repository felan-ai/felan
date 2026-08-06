import { describe, expect, it } from 'vitest';
import type { TaskState } from '../src/contracts.js';
import {
  TaskGraphError,
  createTask,
  emptyTaskState,
  getTask,
  listTasks,
  parseTaskState,
  taskAvailability,
  taskCounts,
  updateTask,
} from '../src/graph.js';

const now = '2026-01-01T00:00:00.000Z';

describe('task graph', () => {
  it('derives readiness from hard prerequisites and unblocks after verified completion', () => {
    let state = create(state0(), 'T-AAAAAA', 'Implement core').state;
    state = createTask(state, {
      title: 'Add tests',
      blockedBy: ['T-AAAAAA'],
    }, 'T-BBBBBB', now).state;

    expect(taskAvailability(getTask(state, 'T-AAAAAA'), state)).toBe('ready');
    expect(taskAvailability(getTask(state, 'T-BBBBBB'), state)).toBe('waiting');
    expect(() => updateTask(state, {
      taskId: 'T-BBBBBB',
      status: 'in_progress',
    }, 'worker-b', now)).toThrow(/waiting on T-AAAAAA/u);

    state = updateTask(state, {
      taskId: 'T-AAAAAA',
      status: 'in_progress',
    }, 'worker-a', now).state;
    state = updateTask(state, {
      taskId: 'T-AAAAAA',
      status: 'completed',
      result: 'Core built and verified',
    }, 'worker-a', now).state;

    expect(taskAvailability(getTask(state, 'T-BBBBBB'), state)).toBe('ready');
    expect(taskCounts(state)).toMatchObject({ total: 2, completed: 1, ready: 1, blocked: 0 });
  });

  it('rejects self-links, unknown dependencies, and cycles', () => {
    let state = create(state0(), 'T-AAAAAA', 'First').state;
    state = createTask(state, {
      title: 'Second',
      blockedBy: ['T-AAAAAA'],
    }, 'T-BBBBBB', now).state;

    expect(() => updateTask(state, {
      taskId: 'T-AAAAAA',
      addBlockedBy: ['T-AAAAAA'],
    }, 'main', now)).toThrow(/self_dependency/u);
    expect(() => updateTask(state, {
      taskId: 'T-AAAAAA',
      addBlockedBy: ['T-CCCCCC'],
    }, 'main', now)).toThrow(/unknown_dependency/u);
    expect(() => updateTask(state, {
      taskId: 'T-AAAAAA',
      addBlockedBy: ['T-BBBBBB'],
    }, 'main', now)).toThrow(/dependency_cycle/u);
  });

  it('allows parallel owners while limiting each session to one active task', () => {
    let state = create(state0(), 'T-AAAAAA', 'First').state;
    state = create(state, 'T-BBBBBB', 'Second').state;
    state = updateTask(state, {
      taskId: 'T-AAAAAA',
      status: 'in_progress',
    }, 'worker-a', now).state;

    expect(() => updateTask(state, {
      taskId: 'T-BBBBBB',
      status: 'in_progress',
    }, 'worker-a', now)).toThrow(/actor_busy/u);

    state = updateTask(state, {
      taskId: 'T-BBBBBB',
      status: 'in_progress',
    }, 'worker-b', now).state;
    expect(listTasks(state, 'active').map((task) => task.ownerSessionId)).toEqual([
      'worker-a',
      'worker-b',
    ]);
    expect(() => updateTask(state, {
      taskId: 'T-AAAAAA',
      status: 'completed',
      result: 'done',
    }, 'worker-b', now)).toThrow(/not_owner/u);
  });

  it('requires explicit stale-claim recovery to change another session\'s active task', () => {
    let state = create(state0(), 'T-AAAAAA', 'Claimed work').state;
    state = updateTask(state, {
      taskId: 'T-AAAAAA',
      status: 'in_progress',
    }, 'worker-a', now).state;

    expect(() => updateTask(state, {
      taskId: 'T-AAAAAA',
      status: 'pending',
    }, 'worker-b', now)).toThrow(/not_owner/u);

    state = updateTask(state, {
      taskId: 'T-AAAAAA',
      status: 'pending',
      force: true,
    }, 'worker-b', now).state;
    expect(getTask(state, 'T-AAAAAA')).toMatchObject({ status: 'pending' });
  });

  it('keeps completed prerequisites stable while a dependent is active', () => {
    let state = create(state0(), 'T-AAAAAA', 'Foundation').state;
    state = createTask(state, {
      title: 'Dependent',
      blockedBy: ['T-AAAAAA'],
    }, 'T-BBBBBB', now).state;
    state = updateTask(state, {
      taskId: 'T-AAAAAA',
      status: 'in_progress',
    }, 'worker-a', now).state;
    state = updateTask(state, {
      taskId: 'T-AAAAAA',
      status: 'completed',
      result: 'verified',
    }, 'worker-a', now).state;
    state = updateTask(state, {
      taskId: 'T-BBBBBB',
      status: 'in_progress',
    }, 'worker-b', now).state;

    expect(() => updateTask(state, {
      taskId: 'T-AAAAAA',
      status: 'pending',
    }, 'worker-a', now)).toThrow(/dependent_started/u);

    state = updateTask(state, {
      taskId: 'T-BBBBBB',
      status: 'pending',
    }, 'worker-b', now).state;
    state = updateTask(state, {
      taskId: 'T-AAAAAA',
      status: 'pending',
    }, 'worker-a', now).state;
    expect(taskAvailability(getTask(state, 'T-BBBBBB'), state)).toBe('waiting');
  });

  it('records explicit blockers, releases ownership, and supports resuming work', () => {
    let state = create(state0(), 'T-AAAAAA', 'Deploy').state;
    state = updateTask(state, {
      taskId: 'T-AAAAAA',
      status: 'in_progress',
      notes: 'Deployment prepared',
    }, 'worker-a', now).state;
    state = updateTask(state, {
      taskId: 'T-AAAAAA',
      status: 'blocked',
      blockedReason: 'Waiting for credentials',
      notes: 'NEXT: obtain deployment credentials',
    }, 'worker-a', now).state;

    expect(getTask(state, 'T-AAAAAA')).toMatchObject({
      status: 'blocked',
      blockedReason: 'Waiting for credentials',
      notes: 'NEXT: obtain deployment credentials',
    });
    expect(getTask(state, 'T-AAAAAA').ownerSessionId).toBeUndefined();

    state = updateTask(state, {
      taskId: 'T-AAAAAA',
      status: 'pending',
    }, 'main', now).state;
    expect(taskAvailability(getTask(state, 'T-AAAAAA'), state)).toBe('ready');
  });

  it('requires claims, results, and blocked reasons for lifecycle transitions', () => {
    const state = create(state0(), 'T-AAAAAA', 'Verify').state;
    expect(() => updateTask(state, {
      taskId: 'T-AAAAAA',
      status: 'completed',
      result: 'done',
    }, 'worker', now)).toThrow(/claim_required/u);
    expect(() => updateTask(state, {
      taskId: 'T-AAAAAA',
      status: 'blocked',
    }, 'worker', now)).toThrow(/blocked_reason_required/u);

    const active = updateTask(state, {
      taskId: 'T-AAAAAA',
      status: 'in_progress',
    }, 'worker', now).state;
    expect(() => updateTask(active, {
      taskId: 'T-AAAAAA',
      status: 'completed',
    }, 'worker', now)).toThrow(/result_required/u);

    const blocked = updateTask(state, {
      taskId: 'T-AAAAAA',
      status: 'blocked',
      blockedReason: 'Waiting for access',
    }, 'worker', now).state;
    expect(() => updateTask(blocked, {
      taskId: 'T-AAAAAA',
      status: 'in_progress',
    }, 'worker', now)).toThrow(/must be pending/u);
  });

  it('validates persisted state before accepting it', () => {
    const state = create(state0(), 'T-AAAAAA', 'Valid').state;
    expect(parseTaskState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(() => parseTaskState({ ...state, schemaVersion: 2 })).toThrow(TaskGraphError);
    expect(() => parseTaskState({
      ...state,
      tasks: [{ ...state.tasks[0], blockedBy: ['T-MISSING'] }],
    })).toThrow(/invalid_id|unknown_dependency/u);

    let dependentState = createTask(state, {
      title: 'Dependent',
      blockedBy: ['T-AAAAAA'],
    }, 'T-BBBBBB', now).state;
    dependentState = updateTask(dependentState, {
      taskId: 'T-AAAAAA',
      status: 'in_progress',
    }, 'worker-a', now).state;
    dependentState = updateTask(dependentState, {
      taskId: 'T-AAAAAA',
      status: 'completed',
      result: 'verified',
    }, 'worker-a', now).state;
    dependentState = updateTask(dependentState, {
      taskId: 'T-BBBBBB',
      status: 'in_progress',
    }, 'worker-b', now).state;
    expect(() => parseTaskState({
      ...dependentState,
      tasks: dependentState.tasks.map((task) => (
        task.id === 'T-AAAAAA'
          ? {
              id: task.id,
              title: task.title,
              priority: task.priority,
              status: 'pending',
              blockedBy: task.blockedBy,
              createdAt: task.createdAt,
              updatedAt: task.updatedAt,
            }
          : task
      )),
    })).toThrow(/waiting on T-AAAAAA/u);
  });
});

function state0(): TaskState {
  return emptyTaskState();
}

function create(state: TaskState, id: string, title: string) {
  return createTask(state, { title }, id, now);
}
