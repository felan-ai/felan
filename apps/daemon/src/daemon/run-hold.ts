import { Type, type Static } from 'typebox';
import { runHoldRefusals, type AgentSession } from '@felan-ai/agent-core';
import { CounterSchema, IdSchema, OriginSchema, enumOf, parseSchema, text } from '@felan-ai/session-protocol';

type Agent = AgentSession['agent'];
type FinishTurn = NonNullable<Agent['finishTurn']>;
type TurnDecision = { action: 'continue' } | { action: 'end' } | undefined;

/** A queued user message as Pi keeps it, with its text and image parts. */
const QueuedUserMessageSchema = Type.Object({
  role: Type.Literal('user'),
  content: Type.Union([Type.String(), Type.Array(Type.Union([
    Type.Object({ type: Type.Literal('text'), text: Type.String() }),
    Type.Object({ type: Type.Literal('image'), data: Type.String(), mimeType: text(128, 1) }),
  ]))]),
  timestamp: CounterSchema,
});
const HeldInputSchema = Type.Object({ kind: enumOf(['steer', 'follow_up'] as const), origin: OriginSchema, message: QueuedUserMessageSchema });
/**
 * Version 1 of the record a daemon writes for a run it held at a step end. The next daemon continues the run only when the
 * session still has this run and its transcript still ends at `leaf`.
 */
const ContinueRecordSchema = Type.Object({
  version: Type.Literal(1),
  session: IdSchema, root: IdSchema, parent: Type.Optional(IdSchema),
  run: Type.Object({ id: IdSchema, origin: Type.Optional(OriginSchema), turnId: Type.Optional(IdSchema) }),
  leaf: IdSchema,
  heldAt: CounterSchema,
  queue: Type.Array(HeldInputSchema, { maxItems: 256 }),
  /** Assistant turns a child execution completed before the hold, so its turn limit carries over. */
  turns: Type.Optional(CounterSchema),
});
export type ContinueRecord = Static<typeof ContinueRecordSchema>;
export type HeldInput = Static<typeof HeldInputSchema>;
/**
 * Larger queued input cannot be recorded. Before `held` the hold is cancelled; a run that parks after `held` gets no record
 * and is interrupted at the stop.
 */
export const CONTINUE_RECORD_BYTES = 32 * 1024 * 1024;

export function parseContinueRecord(value: unknown): ContinueRecord { return parseSchema(ContinueRecordSchema, value); }

export const RUN_CONTINUED_MESSAGE_TYPE = 'felan-daemon-run-continued';
export const RUN_CONTINUED_TEXT = 'The session host restarted between two steps of this run. The results of every tool call you made are above. Continue the task from where you stopped; do not repeat tool calls that already have results.';

export interface ParkedStep {
  readonly leaf: string;
  /** `continue` resumes the step's normal scheduling; `end` ends the Pi run without another model request. */
  release(outcome: 'continue' | 'end'): void;
}

export interface StepHoldHooks {
  /** False unless a hold is waiting or holding; a normal step pays only this call. */
  active(): boolean;
  parked(step: ParkedStep): void;
  released(step: ParkedStep): void;
}

/**
 * Wraps the agent's step-end hook so a held run stops after its assistant message and tool results are saved, before the
 * next model request. Only a step whose tool calls continue the run parks, so a continued transcript always ends with tool
 * results. A response without tool calls, a failed or aborted response, a batch that terminates the run, and a session whose
 * extensions refuse a hold through `runHoldRefusals` keep their normal scheduling.
 */
export function installStepHold(session: AgentSession, hooks: StepHoldHooks): void {
  const agent = session.agent;
  // Like queue observation, a runtime without Pi's agent loop has no step end to hold.
  if (!agent) return;
  // Only calls that ask the loop to stop are remembered; an ordinary tool call adds nothing.
  const terminated = new Set<string>();
  const afterToolCall = agent.afterToolCall;
  agent.afterToolCall = async (context, signal) => {
    const result = await afterToolCall?.(context, signal);
    if ((result?.terminate ?? context.result.terminate) === true) terminated.add(context.toolCall.id);
    return result;
  };
  const finishTurn = agent.finishTurn;
  const wrapped: FinishTurn = async (turn, signal) => {
    const decision: TurnDecision = (await finishTurn?.(turn, signal)) ?? undefined;
    let terminate = false;
    if (terminated.size) {
      terminate = turn.toolResults.length > 0 && turn.toolResults.every(result => terminated.has(result.toolCallId));
      for (const result of turn.toolResults) terminated.delete(result.toolCallId);
    }
    if (!hooks.active() || signal?.aborted || decision?.action === 'end') return decision;
    if (turn.message.stopReason === 'error' || turn.message.stopReason === 'aborted') return decision;
    if (terminate || !turn.toolResults.length || runHoldRefusals(session).length) return decision;
    return await new Promise<TurnDecision>(resolve => {
      let settled = false;
      const step: ParkedStep = { leaf: session.sessionManager.getLeafId() ?? '', release: outcome => {
        if (settled) return;
        settled = true; signal?.removeEventListener('abort', onAbort);
        hooks.released(step);
        resolve(outcome === 'end' ? { action: 'end' } : decision);
      } };
      // Aborting a parked run, as a restart's shutdown does, ends it cleanly: no further request and no aborted message.
      const onAbort = () => step.release('end');
      signal?.addEventListener('abort', onAbort, { once: true });
      hooks.parked(step);
    });
  };
  agent.finishTurn = wrapped;
}
