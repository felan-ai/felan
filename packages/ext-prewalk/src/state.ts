import { MAX_AUTOMATIC_CONTINUATIONS } from './prompts.js';

export type PrewalkPhase = 'idle' | 'armed' | 'planning' | 'handoff' | 'implementing' | 'restoring';

export interface PrewalkState {
  phase: PrewalkPhase;
  run?: PrewalkRunState;
}

export interface PrewalkRunState {
  mutationCallIds: string[];
  continuationCount: number;
  continuationArmed: boolean;
}

export interface ToolCallSummary {
  toolCallId: string;
  toolName: string;
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

const MUTATION_TOOLS = ['edit', 'write', 'apply_patch'] as const;

export const MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set(MUTATION_TOOLS);

export function validateArmingTools(activeTools: readonly string[]): ValidationResult {
  return activeTools.some((toolName) => MUTATION_TOOL_NAMES.has(toolName))
    ? { ok: true }
    : { ok: false, reason: 'Prewalk requires an active mutation tool (edit, write, or apply_patch).' };
}

export function createRunState(): PrewalkRunState {
  return {
    mutationCallIds: [],
    continuationCount: 0,
    continuationArmed: true,
  };
}

export function beginTurn(state: PrewalkRunState): PrewalkRunState {
  return {
    ...state,
    mutationCallIds: [],
  };
}

export function recordToolCall(state: PrewalkRunState, call: ToolCallSummary): PrewalkRunState {
  if (!MUTATION_TOOL_NAMES.has(call.toolName)) return state;

  return {
    ...state,
    mutationCallIds: [...state.mutationCallIds, call.toolCallId],
  };
}

export function reduceTurn(
  state: PrewalkRunState,
  results: readonly ToolResultSummary[],
  options: { allowContinuation?: boolean } = {},
): TurnDecision {
  const successfulIds = new Set(results.filter((result) => !result.isError).map((result) => result.toolCallId));
  const shouldHandoff = state.mutationCallIds.some((toolCallId) => successfulIds.has(toolCallId));

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
      mutationCallIds: [],
      continuationCount,
      continuationArmed,
    },
    shouldHandoff,
    shouldContinue,
  };
}
