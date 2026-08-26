import { MAX_AUTOMATIC_CONTINUATIONS } from './prompts.js';

export type PrewalkPhase = 'idle' | 'armed' | 'planning' | 'reviewing' | 'handoff' | 'implementing' | 'restoring';

export interface PrewalkState {
  phase: PrewalkPhase;
  run?: PrewalkRunState;
}

export interface PrewalkRunState {
  mutationCallIds: string[];
  taskCreateCallIds: string[];
  taskClaimCallIds: string[];
  taskCreateSucceeded: boolean;
  taskClaimSucceeded: boolean;
  taskGateRequired: boolean;
  taskGraphReady: boolean;
  continuationCount: number;
  continuationArmed: boolean;
  handoffArmed: boolean;
  reviewRequired: boolean;
  reviewApproved: boolean;
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
  shouldReview: boolean;
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

const MUTATION_TOOLS = ['edit', 'write', 'apply_patch'] as const;

export const MUTATION_TOOL_NAMES: ReadonlySet<string> = new Set(MUTATION_TOOLS);

export function validateArmingTools(activeTools: readonly string[]): ValidationResult {
  return activeTools.some((toolName) => MUTATION_TOOL_NAMES.has(toolName))
    ? { ok: true }
    : { ok: false, reason: 'Prewalk requires an active mutation tool (edit, write, or apply_patch).' };
}

export function createRunState(options: {
  handoffArmed?: boolean;
  taskGateRequired?: boolean;
  reviewRequired?: boolean;
} = {}): PrewalkRunState {
  const taskGateRequired = options.taskGateRequired ?? false;
  return {
    mutationCallIds: [],
    taskCreateCallIds: [],
    taskClaimCallIds: [],
    taskCreateSucceeded: false,
    taskClaimSucceeded: false,
    taskGateRequired,
    taskGraphReady: !taskGateRequired,
    continuationCount: 0,
    continuationArmed: true,
    handoffArmed: options.handoffArmed ?? true,
    reviewRequired: options.reviewRequired ?? false,
    reviewApproved: false,
  };
}

export function beginTurn(state: PrewalkRunState): PrewalkRunState {
  return {
    ...state,
    mutationCallIds: [],
    taskCreateCallIds: [],
    taskClaimCallIds: [],
    handoffArmed: true,
  };
}

export function recordToolCall(state: PrewalkRunState, call: ToolCallSummary): PrewalkRunState {
  const isMutation = MUTATION_TOOL_NAMES.has(call.toolName);
  const isTaskCreate = call.toolName === 'TaskCreate';
  const isTaskClaim = call.toolName === 'TaskUpdate' && isInProgressClaim(call.input);
  if (!isMutation && !isTaskCreate && !isTaskClaim) return state;

  return {
    ...state,
    mutationCallIds: isMutation
      ? [...state.mutationCallIds, call.toolCallId]
      : state.mutationCallIds,
    taskCreateCallIds: isTaskCreate
      ? [...state.taskCreateCallIds, call.toolCallId]
      : state.taskCreateCallIds,
    taskClaimCallIds: isTaskClaim
      ? [...state.taskClaimCallIds, call.toolCallId]
      : state.taskClaimCallIds,
  };
}

export function reduceTurn(
  state: PrewalkRunState,
  results: readonly ToolResultSummary[],
  options: { allowContinuation?: boolean; planPresented?: boolean } = {},
): TurnDecision {
  const successfulIds = new Set(results.filter((result) => !result.isError).map((result) => result.toolCallId));
  const taskCreateSucceeded = state.taskCreateSucceeded
    || hasSuccessfulCall(state.taskCreateCallIds, successfulIds);
  const taskClaimSucceeded = state.taskClaimSucceeded
    || hasSuccessfulCall(state.taskClaimCallIds, successfulIds);
  const taskGraphReady = !state.taskGateRequired || (taskCreateSucceeded && taskClaimSucceeded);
  const shouldHandoff = state.handoffArmed
    && taskGraphReady
    && (!state.reviewRequired || state.reviewApproved)
    && state.mutationCallIds.some((toolCallId) => successfulIds.has(toolCallId));
  const shouldReview = state.reviewRequired
    && !state.reviewApproved
    && taskGraphReady
    && options.planPresented === true;

  let continuationArmed = results.some((result) => !result.isError) || state.continuationArmed;
  let continuationCount = state.continuationCount;
  let shouldContinue = false;

  if (
    !shouldHandoff
    && !shouldReview
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
      taskCreateCallIds: [],
      taskClaimCallIds: [],
      taskCreateSucceeded,
      taskClaimSucceeded,
      taskGateRequired: state.taskGateRequired,
      taskGraphReady,
      continuationCount,
      continuationArmed,
      handoffArmed: state.handoffArmed,
      reviewRequired: state.reviewRequired,
      reviewApproved: state.reviewApproved,
    },
    shouldHandoff,
    shouldContinue,
    shouldReview,
  };
}

function hasSuccessfulCall(callIds: readonly string[], successfulIds: ReadonlySet<string>): boolean {
  return callIds.some((callId) => successfulIds.has(callId));
}

function isInProgressClaim(input: unknown): boolean {
  return isRecord(input) && input.status === 'in_progress';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
