import { describe, expect, it } from 'vitest';
import {
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
  type PrewalkRunState,
  type ToolResultSummary,
} from '../state.js';

function call(state: PrewalkRunState, toolCallId: string, toolName: string): PrewalkRunState {
  return recordToolCall(state, { toolCallId, toolName });
}

function ok(toolCallId: string): ToolResultSummary {
  return { toolCallId, isError: false };
}

function error(toolCallId: string): ToolResultSummary {
  return { toolCallId, isError: true };
}

describe('arming validation', () => {
  it.each(['edit', 'write', 'apply_patch'])('accepts the explicit mutation tool %s', (mutationTool) => {
    expect(validateArmingTools(['read', mutationTool])).toEqual({ ok: true });
  });

  it('does not treat shell execution as an explicit mutation tool', () => {
    expect(validateArmingTools(['read', 'bash', 'exec_command', 'write_stdin'])).toEqual({
      ok: false,
      reason: 'Prewalk requires an active mutation tool (edit, write, or apply_patch).',
    });
  });
});

describe('turn reduction', () => {
  it.each(['edit', 'write', 'apply_patch'])('hands off after a successful %s call', (mutationTool) => {
    let state = createRunState();
    state = call(state, 'mutation', mutationTool);

    expect(reduceTurn(state, [ok('mutation')]).shouldHandoff).toBe(true);
  });

  it.each(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'read', 'bash', 'exec_command', 'write_stdin'])(
    'does not treat %s as a mutation',
    (toolName) => {
      let state = createRunState();
      state = call(state, 'other', toolName);

      expect(reduceTurn(state, [ok('other')]).shouldHandoff).toBe(false);
    },
  );

  it('requires a successful mutation result', () => {
    let state = createRunState();
    state = call(state, 'mutation', 'write');

    const failedMutation = reduceTurn(state, [error('mutation')]);
    expect(failedMutation.shouldHandoff).toBe(false);
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
    let state = createRunState();
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
  it('requires repository exploration and dependency-aware Tasks', () => {
    expect(PLANNING_INSTRUCTION).toContain('Explore the repository thoroughly');
    expect(PLANNING_INSTRUCTION).toContain('affected files and symbols');
    expect(PLANNING_INSTRUCTION).toContain('Use TaskCreate');
    expect(PLANNING_INSTRUCTION).toContain('blocked_by dependencies');
    expect(PLANNING_INSTRUCTION).toContain('next ready task is unambiguous');
    expect(PLANNING_INSTRUCTION).toContain('Use TaskUpdate');
    expect(PLANNING_INSTRUCTION).toContain('Start implementing immediately');
  });

  it('requires focused task completion and full verification', () => {
    expect(VERIFICATION_INSTRUCTION).toContain('existing session task graph');
    expect(VERIFICATION_INSTRUCTION).toContain('limited to the requested scope');
    expect(VERIFICATION_INSTRUCTION).toContain('full relevant test module or suite');
    expect(VERIFICATION_INSTRUCTION).toContain('verified result');
  });

  it('keeps orchestration details out of the phase guidance', () => {
    const instructions = `${PLANNING_INSTRUCTION}\n${VERIFICATION_INSTRUCTION}`;

    expect(instructions).not.toMatch(/\b(?:handoff|model|trajectory)\b|planning phase|next request|first mutation/iu);
  });
});
