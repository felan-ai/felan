import { describe, expect, it } from 'vitest';
import {
  BEADS_PLANNING_INSTRUCTION,
  BEADS_VERIFICATION_INSTRUCTION,
  MAX_AUTOMATIC_CONTINUATIONS,
  PLANNING_INSTRUCTION,
  VERIFICATION_INSTRUCTION,
} from '../prompts.js';
import {
  beginTurn,
  createRunState,
  recordToolCall,
  reduceTurn,
  validateArmingTools,
  validateTodoWriteInput,
  type PrewalkRunState,
  type ToolResultSummary,
} from '../state.js';

function todos(count: number, inProgressIndexes: number[] = [0]) {
  return Array.from({ length: count }, (_, index) => ({
    content: `Task ${index + 1}`,
    activeForm: `Doing task ${index + 1}`,
    status: inProgressIndexes.includes(index) ? 'in_progress' : 'pending',
  }));
}

function call(state: PrewalkRunState, toolCallId: string, toolName: string): PrewalkRunState {
  return recordToolCall(state, { toolCallId, toolName });
}

function beadsCall(state: PrewalkRunState, toolCallId: string, command: string): PrewalkRunState {
  return recordToolCall(state, { toolCallId, toolName: 'bash', input: { command } }, true);
}

function ok(toolCallId: string): ToolResultSummary {
  return { toolCallId, isError: false };
}

function error(toolCallId: string): ToolResultSummary {
  return { toolCallId, isError: true };
}

describe('arming validation', () => {
  it.each(['edit', 'write', 'apply_patch'])('accepts todo_write with %s', (mutationTool) => {
    expect(validateArmingTools(['read', 'todo_write', mutationTool])).toEqual({ ok: true });
  });

  it('requires a shell tool instead of todo_write for Beads tracking', () => {
    expect(validateArmingTools(['bash', 'edit'], true)).toEqual({ ok: true });
    expect(validateArmingTools(['todo_write', 'edit'], true)).toEqual({
      ok: false,
      reason: 'Prewalk requires an active shell tool (bash or exec_command).',
    });
  });

  it('reports each missing capability', () => {
    expect(validateArmingTools(['edit'])).toEqual({
      ok: false,
      reason: 'Prewalk requires the active todo_write tool.',
    });
    expect(validateArmingTools(['todo_write'])).toEqual({
      ok: false,
      reason: 'Prewalk requires an active mutation tool (edit, write, or apply_patch).',
    });
    expect(validateArmingTools(['read'])).toEqual({
      ok: false,
      reason: 'Prewalk requires the active todo_write tool and an active mutation tool (edit, write, or apply_patch).',
    });
  });
});

describe('todo_write validation', () => {
  it.each([5, 9])('accepts %s items and exactly one in_progress item', (count) => {
    expect(validateTodoWriteInput({ todos: todos(count) })).toEqual({ ok: true });
  });

  it.each([4, 10])('rejects the adjacent %s-item boundary', (count) => {
    expect(validateTodoWriteInput({ todos: todos(count) })).toEqual({
      ok: false,
      reason: 'Prewalk requires 5-9 todo items before the first mutation.',
    });
  });

  it('requires exactly one in_progress item', () => {
    expect(validateTodoWriteInput({ todos: todos(5, []) })).toEqual({
      ok: false,
      reason: 'Prewalk requires exactly one in_progress todo item.',
    });
    expect(validateTodoWriteInput({ todos: todos(5, [0, 1]) })).toEqual({
      ok: false,
      reason: 'Prewalk requires exactly one in_progress todo item.',
    });
  });

  it('rejects malformed input with actionable reasons', () => {
    expect(validateTodoWriteInput({})).toEqual({
      ok: false,
      reason: 'Prewalk requires todo_write input with a todos array.',
    });
    expect(validateTodoWriteInput({ todos: [...todos(4), { status: 'unknown' }] })).toEqual({
      ok: false,
      reason: 'Every Prewalk todo must have a valid pending, in_progress, or completed status.',
    });
  });
});

describe('turn reduction', () => {
  it.each([
    "bd create --title 'Implement parser' --type task",
    'bd update FEL-9 --status in_progress',
    'cd repo && bd update FEL-9 --status in_progress',
    'cd repo; bd close FEL-9',
    'cd repo\nbd reopen FEL-9',
    'MODE=local bd comment FEL-9 "Implementation started"',
  ])('accepts a successful direct or chained Beads mutation: %s', (command) => {
    let state = createRunState();
    state = beadsCall(state, 'beads', command);
    state = call(state, 'mutation', 'edit');

    expect(reduceTurn(state, [ok('beads'), ok('mutation')]).shouldHandoff).toBe(true);
  });

  it('accepts exec_command Beads updates using cmd input', () => {
    let state = createRunState();
    state = recordToolCall(
      state,
      { toolCallId: 'beads', toolName: 'exec_command', input: { cmd: 'bd update FEL-9 --status in_progress' } },
      true,
    );
    state = call(state, 'mutation', 'write');

    expect(reduceTurn(state, [ok('beads'), ok('mutation')]).shouldHandoff).toBe(true);
  });

  it('ignores read-only and unrelated shell commands for the Beads gate', () => {
    let state = createRunState();
    state = beadsCall(state, 'status', 'bd status');
    state = beadsCall(state, 'git', 'git status');
    state = call(state, 'mutation', 'edit');

    expect(reduceTurn(state, [ok('status'), ok('git'), ok('mutation')]).shouldHandoff).toBe(false);
  });

  it.each([
    'echo bd update FEL-9 --status in_progress',
    'echo "bd update FEL-9 --status in_progress"',
    "printf '%s\\n' 'bd update FEL-9 --status in_progress'",
    "git commit -m 'bd update FEL-9'",
    "message='bd update FEL-9' && echo \"$message\"",
    ": 'bd update FEL-9 --status in_progress'",
    'bd status --format update',
    '# bd update FEL-9 --status in_progress',
    'echo done # bd update FEL-9 --status in_progress',
  ])('does not treat Beads command text as tracking: %s', (command) => {
    let state = createRunState();
    state = beadsCall(state, 'beads-text', command);
    state = call(state, 'mutation', 'edit');

    expect(reduceTurn(state, [ok('beads-text'), ok('mutation')]).shouldHandoff).toBe(false);
  });

  it('hands off after an open gate and a successful mutation', () => {
    let state = { ...createRunState(), trackingGateOpen: true };
    state = call(state, 'mutation', 'edit');

    expect(reduceTurn(state, [ok('mutation')]).shouldHandoff).toBe(true);
  });

  it('hands off when successful tracking precedes a successful mutation in one turn', () => {
    let state = createRunState();
    state = call(state, 'todo', 'todo_write');
    state = call(state, 'read', 'read');
    state = call(state, 'mutation', 'write');

    const decision = reduceTurn(state, [ok('mutation'), ok('todo'), ok('read')]);

    expect(decision.shouldHandoff).toBe(true);
    expect(decision.state.trackingGateOpen).toBe(true);
  });

  it('uses call order rather than parallel result order', () => {
    let state = createRunState();
    state = call(state, 'todo', 'todo_write');
    state = call(state, 'mutation', 'apply_patch');

    expect(reduceTurn(state, [ok('mutation'), ok('todo')]).shouldHandoff).toBe(true);
    expect(reduceTurn(state, [ok('todo'), ok('mutation')]).shouldHandoff).toBe(true);
  });

  it('does not retain a mutation that precedes successful tracking', () => {
    let state = createRunState();
    state = call(state, 'early-mutation', 'edit');
    state = call(state, 'todo', 'todo_write');

    const firstTurn = reduceTurn(state, [ok('todo'), ok('early-mutation')]);
    expect(firstTurn.shouldHandoff).toBe(false);
    expect(firstTurn.state.trackingGateOpen).toBe(true);

    state = call(beginTurn(firstTurn.state), 'later-mutation', 'edit');
    expect(reduceTurn(state, [ok('later-mutation')]).shouldHandoff).toBe(true);
  });

  it('requires successful tracking and mutation results', () => {
    let state = createRunState();
    state = call(state, 'todo', 'todo_write');
    state = call(state, 'mutation', 'write');

    const failedTodo = reduceTurn(state, [error('todo'), ok('mutation')]);
    expect(failedTodo.shouldHandoff).toBe(false);
    expect(failedTodo.state.trackingGateOpen).toBe(false);

    const failedMutation = reduceTurn(state, [ok('todo'), error('mutation')]);
    expect(failedMutation.shouldHandoff).toBe(false);
    expect(failedMutation.state.trackingGateOpen).toBe(true);

    state = call(beginTurn(failedMutation.state), 'retry', 'write');
    expect(reduceTurn(state, [ok('retry')]).shouldHandoff).toBe(true);
  });

  it('ignores unrelated successful results for the handoff gate', () => {
    let state = createRunState();
    state = call(state, 'read', 'read');

    expect(reduceTurn(state, [ok('read')]).shouldHandoff).toBe(false);
  });
});

describe('bounded planning continuations', () => {
  it('queues only once during a no-progress stretch', () => {
    const first = reduceTurn(createRunState(), []);
    const second = reduceTurn(beginTurn(first.state), []);

    expect(first.shouldContinue).toBe(true);
    expect(second.shouldContinue).toBe(false);
    expect(second.state.continuationCount).toBe(1);
  });

  it('rearms after any successful tool result', () => {
    const first = reduceTurn(createRunState(), []);
    const progress = reduceTurn(beginTurn(first.state), [ok('read')]);
    const afterProgress = reduceTurn(beginTurn(progress.state), []);

    expect(progress.shouldContinue).toBe(false);
    expect(afterProgress.shouldContinue).toBe(true);
    expect(afterProgress.state.continuationCount).toBe(2);
  });

  it('does not rearm after a failed tool result', () => {
    const first = reduceTurn(createRunState(), []);
    const failure = reduceTurn(beginTurn(first.state), [error('read')]);
    const afterFailure = reduceTurn(beginTurn(failure.state), []);

    expect(afterFailure.shouldContinue).toBe(false);
  });

  it('never exceeds the continuation cap', () => {
    let state = createRunState();

    for (let index = 0; index < MAX_AUTOMATIC_CONTINUATIONS; index += 1) {
      const continuation = reduceTurn(beginTurn(state), []);
      expect(continuation.shouldContinue).toBe(true);
      state = reduceTurn(beginTurn(continuation.state), [ok(`progress-${index}`)]).state;
    }

    const exhausted = reduceTurn(beginTurn(state), []);
    expect(exhausted.shouldContinue).toBe(false);
    expect(exhausted.state.continuationCount).toBe(MAX_AUTOMATIC_CONTINUATIONS);
  });

  it('does not queue a continuation when the turn qualifies for handoff', () => {
    let state = { ...createRunState(), trackingGateOpen: true };
    state = call(state, 'mutation', 'edit');

    const decision = reduceTurn(state, [ok('mutation')]);
    expect(decision.shouldHandoff).toBe(true);
    expect(decision.shouldContinue).toBe(false);
  });

  it('does not consume the continuation budget for an ineligible completion', () => {
    const decision = reduceTurn(createRunState(), [], { allowContinuation: false });

    expect(decision.shouldContinue).toBe(false);
    expect(decision.state.continuationCount).toBe(0);
    expect(decision.state.continuationArmed).toBe(true);
  });
});

describe('phase prompts', () => {
  it('requires repository exploration, detailed tasks, and immediate implementation', () => {
    expect(PLANNING_INSTRUCTION).toContain('Explore the repository thoroughly');
    expect(PLANNING_INSTRUCTION).toContain('affected files and symbols');
    expect(PLANNING_INSTRUCTION).toContain('5-9 detailed implementation tasks');
    expect(PLANNING_INSTRUCTION).toContain('Start implementing immediately');
  });

  it('requires focused completion and full verification', () => {
    expect(VERIFICATION_INSTRUCTION).toContain('existing todo_write checklist in task order');
    expect(VERIFICATION_INSTRUCTION).toContain('limited to the requested scope');
    expect(VERIFICATION_INSTRUCTION).toContain('full relevant test module or suite');
  });

  it('creates and executes a dependency-aware Beads task graph', () => {
    expect(BEADS_PLANNING_INSTRUCTION).toContain('direct bd CLI commands');
    expect(BEADS_PLANNING_INSTRUCTION).toContain('Create detailed Beads tasks');
    expect(BEADS_PLANNING_INSTRUCTION).toContain('add dependencies');
    expect(BEADS_PLANNING_INSTRUCTION).toContain('while honoring their dependencies');
    expect(BEADS_VERIFICATION_INSTRUCTION).toContain('Honor task dependencies');
    expect(BEADS_VERIFICATION_INSTRUCTION).toContain('close each completed Bead');
  });

  it('does not expose orchestration details', () => {
    const instructions = [
      PLANNING_INSTRUCTION,
      VERIFICATION_INSTRUCTION,
      BEADS_PLANNING_INSTRUCTION,
      BEADS_VERIFICATION_INSTRUCTION,
    ].join('\n');

    expect(instructions).not.toMatch(/\b(?:handoff|model|trajectory)\b|planning phase|next request|first mutation/i);
  });
});
