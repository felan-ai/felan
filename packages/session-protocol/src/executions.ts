import { Type, type Static } from 'typebox';
import { LIMITS } from './limits.js';
import { CounterSchema, CursorSchema, IdSchema, ModelSchema, enumOf, text } from './schema.js';

export const ExecutionSchema = Type.Object({
  id: IdSchema, parent: Type.Optional(IdSchema), label: Type.Optional(text(256)), description: Type.Optional(text(512)),
  completionPending: Type.Optional(Type.Boolean()),
  createdAt: Type.Optional(text(64)), startedAt: Type.Optional(text(64)), completedAt: Type.Optional(text(64)),
  session: Type.Optional(Type.Object({ id: IdSchema, root: IdSchema, parent: Type.Optional(IdSchema) }, { additionalProperties: false })),
  state: enumOf(['queued', 'running', 'completed', 'failed', 'cancelled'] as const), model: Type.Optional(ModelSchema),
  result: Type.Optional(Type.Object({ text: text(64 * 1024), error: Type.Optional(text(4096)), truncated: Type.Boolean() }, { additionalProperties: false })),
  usage: Type.Optional(Type.Object({ input: CounterSchema, output: CounterSchema, cacheRead: CounterSchema, cacheWrite: CounterSchema,
    cacheWrite1h: CounterSchema, cost: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }, { additionalProperties: false })),
}, { additionalProperties: false });
export const ExecutionsPageSchema = Type.Object({ items: Type.Array(ExecutionSchema),
  nextCursor: Type.Optional(CursorSchema) }, { additionalProperties: false });
export type Execution = Static<typeof ExecutionSchema>;
