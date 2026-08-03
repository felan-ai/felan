import { MAX_AUTOMATIC_CONTINUATIONS } from './prompts.js';

export type PrewalkPhase = 'idle' | 'armed' | 'planning' | 'handoff' | 'implementing' | 'restoring';

export interface PrewalkState {
  phase: PrewalkPhase;
  run?: PrewalkRunState;
}

export interface PrewalkRunState {
  trackingGateOpen: boolean;
  toolCalls: RecordedToolCall[];
  nextOrdinal: number;
  continuationCount: number;
  continuationArmed: boolean;
}

export interface ToolCallSummary {
  toolCallId: string;
  toolName: string;
  input?: unknown;
}

export interface ToolResultSummary {
  toolCallId: string;
  isError: boolean;
}

export interface TurnDecision {
  state: PrewalkRunState;
  shouldHandoff: boolean;
  shouldContinue: boolean;
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

type RecordedToolCall = {
  toolCallId: string;
  kind: 'tracking' | 'mutation';
  ordinal: number;
};

const MUTATION_TOOLS = ['edit', 'write', 'apply_patch'] as const;
const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed']);

export const MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set(MUTATION_TOOLS);

export function validateArmingTools(activeTools: readonly string[], useBeads = false): ValidationResult {
  const missingTracking = useBeads
    ? !activeTools.some((toolName) => toolName === 'bash' || toolName === 'exec_command')
    : !activeTools.includes('todo_write');
  const missingMutation = !activeTools.some((toolName) => MUTATION_TOOL_NAMES.has(toolName));

  if (!missingTracking && !missingMutation) return { ok: true };

  const requirements: string[] = [];
  if (missingTracking) {
    requirements.push(useBeads ? 'an active shell tool (bash or exec_command)' : 'the active todo_write tool');
  }
  if (missingMutation) requirements.push('an active mutation tool (edit, write, or apply_patch)');

  return {
    ok: false,
    reason: `Prewalk requires ${requirements.join(' and ')}.`,
  };
}

export function validateTodoWriteInput(input: unknown): ValidationResult {
  if (!isRecord(input) || !Array.isArray(input.todos)) {
    return { ok: false, reason: 'Prewalk requires todo_write input with a todos array.' };
  }

  if (input.todos.length < 5 || input.todos.length > 9) {
    return { ok: false, reason: 'Prewalk requires 5-9 todo items before the first mutation.' };
  }

  if (input.todos.some((todo) => !isRecord(todo) || !TODO_STATUSES.has(String(todo.status)))) {
    return { ok: false, reason: 'Every Prewalk todo must have a valid pending, in_progress, or completed status.' };
  }

  const inProgressCount = input.todos.filter((todo) => todo.status === 'in_progress').length;
  if (inProgressCount !== 1) {
    return { ok: false, reason: 'Prewalk requires exactly one in_progress todo item.' };
  }

  return { ok: true };
}

export function createRunState(): PrewalkRunState {
  return {
    trackingGateOpen: false,
    toolCalls: [],
    nextOrdinal: 0,
    continuationCount: 0,
    continuationArmed: true,
  };
}

export function beginTurn(state: PrewalkRunState): PrewalkRunState {
  return {
    ...state,
    toolCalls: [],
    nextOrdinal: 0,
  };
}

export function recordToolCall(state: PrewalkRunState, call: ToolCallSummary, useBeads = false): PrewalkRunState {
  const ordinal = state.nextOrdinal;
  const nextState = { ...state, nextOrdinal: ordinal + 1 };
  const kind = isTrackingCall(call, useBeads)
    ? 'tracking'
    : MUTATION_TOOL_NAMES.has(call.toolName)
      ? 'mutation'
      : undefined;

  if (!kind) return nextState;

  return {
    ...nextState,
    toolCalls: [...state.toolCalls, { toolCallId: call.toolCallId, kind, ordinal }],
  };
}

export function reduceTurn(
  state: PrewalkRunState,
  results: readonly ToolResultSummary[],
  options: { allowContinuation?: boolean } = {},
): TurnDecision {
  const successfulIds = new Set(results.filter((result) => !result.isError).map((result) => result.toolCallId));
  const successfulTracking = state.toolCalls.filter(
    (call) => call.kind === 'tracking' && successfulIds.has(call.toolCallId),
  );
  const successfulMutations = state.toolCalls.filter(
    (call) => call.kind === 'mutation' && successfulIds.has(call.toolCallId),
  );

  const shouldHandoff = state.trackingGateOpen
    ? successfulMutations.length > 0
    : successfulMutations.some((mutation) => successfulTracking.some((tracking) => tracking.ordinal < mutation.ordinal));

  let continuationArmed = results.some((result) => !result.isError) || state.continuationArmed;
  let continuationCount = state.continuationCount;
  let shouldContinue = false;

  if (
    !shouldHandoff
    && options.allowContinuation !== false
    && results.length === 0
    && continuationArmed
    && continuationCount < MAX_AUTOMATIC_CONTINUATIONS
  ) {
    shouldContinue = true;
    continuationCount += 1;
    continuationArmed = false;
  }

  return {
    state: {
      trackingGateOpen: state.trackingGateOpen || successfulTracking.length > 0,
      toolCalls: [],
      nextOrdinal: 0,
      continuationCount,
      continuationArmed,
    },
    shouldHandoff,
    shouldContinue,
  };
}

function isTrackingCall(call: ToolCallSummary, useBeads: boolean): boolean {
  if (!useBeads) return call.toolName === 'todo_write';
  if (call.toolName !== 'bash' && call.toolName !== 'exec_command') return false;
  if (!isRecord(call.input)) return false;
  const command = call.input.command ?? call.input.cmd;
  return typeof command === 'string'
    && /(?:^|[;&|({}\s])bd\b(?=[^;&|]*\b(?:create|new|q|update|close|done|link|dep|reopen|assign|priority|tag|label|note|comment|edit|set-state)\b)/.test(command);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
