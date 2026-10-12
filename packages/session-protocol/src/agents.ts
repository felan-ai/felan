import { Type, type Static } from 'typebox';
import { LIMITS } from './limits.js';
import { CounterSchema, CursorSchema, IdSchema, enumOf, text } from './schema.js';

export const AgentErrorSchema = Type.Object({ code: enumOf(['unknown_agent_type', 'invalid_request', 'unsupported_model', 'unsupported_thinking',
  'depth_exceeded', 'turn_limit_reached', 'model_request_failed', 'cancelled_by_parent', 'timed_out', 'host_shutdown', 'not_found', 'not_child',
  'not_steerable', 'parent_unavailable', 'host_unavailable', 'internal_error'] as const), message: text(LIMITS.statusTextBytes) }, { additionalProperties: false });
export const AgentSummarySchema = Type.Object({
  agentId: IdSchema, parentSessionId: IdSchema, rootSessionId: IdSchema, type: text(256), description: text(16_384),
  status: enumOf(['queued', 'running', 'completed', 'failed', 'timed_out', 'cancelled'] as const),
  createdAt: text(64), startedAt: Type.Optional(text(64)), completedAt: Type.Optional(text(64)), error: Type.Optional(AgentErrorSchema),
  sessionId: Type.Optional(IdSchema), model: Type.Optional(text(512)), resultAvailable: Type.Boolean(),
  usage: Type.Optional(Type.Object({ input: CounterSchema, output: CounterSchema, cacheRead: CounterSchema, cacheWrite: CounterSchema,
    cacheWrite1h: CounterSchema, cost: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }, { additionalProperties: false })),
}, { additionalProperties: false });
export const AgentsPageSchema = Type.Object({ generation: text(64, 64), entries: Type.Array(AgentSummarySchema, { maxItems: LIMITS.pageEntries }),
  cursor: Type.Optional(CursorSchema) }, { additionalProperties: false, 'x-maxEncodedBytes': LIMITS.pageBytes });
export const AgentReadSchema = Type.Object({ agent: AgentSummarySchema, result: Type.Optional(text(256 * 1024)) }, { additionalProperties: false });
export const AgentControlSchema = Type.Union([
  Type.Object({ ok: Type.Literal(true), agent: AgentSummarySchema }, { additionalProperties: false }),
  Type.Object({ ok: Type.Literal(false), error: AgentErrorSchema }, { additionalProperties: false }),
]);
export type AgentSummary = Static<typeof AgentSummarySchema>;
