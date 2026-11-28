import { Type, type Static } from 'typebox';
import { CounterSchema, IdSchema, enumOf, text } from './schema.js';

const LabelSchema = Type.String({ ...text(128, 1), pattern: '^[^\u0000-\u001f\u007f-\u009f]+$' });
/** `Date.prototype.toISOString()` output, including expanded years. */
const ResetAtSchema = Type.String({ maxLength: 32, pattern: '^(?:\\d{4}|[+-]\\d{6})-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' });

export const SubscriptionProviderSchema = enumOf(['anthropic', 'codex', 'xai', 'openai'] as const);
export const SubscriptionUsageWindowSchema = Type.Object({
  label: LabelSchema, usedPercent: Type.Number({ minimum: 0, maximum: 100 }), resetAt: Type.Optional(ResetAtSchema),
}, { additionalProperties: false });
/**
 * Plan usage of one signed-in subscription. `updatedAt` is the time of the last successful fetch. An entry with `error`
 * keeps the windows of that last successful fetch, if any, so a client can show them as stale.
 */
export const SubscriptionUsageSchema = Type.Object({
  provider: SubscriptionProviderSchema, modelProvider: IdSchema, label: LabelSchema,
  windows: Type.Array(SubscriptionUsageWindowSchema, { maxItems: 16 }),
  updatedAt: Type.Optional(CounterSchema),
  error: Type.Optional(Type.Object({
    code: enumOf(['NO_CREDENTIALS', 'COMPANION_UNAVAILABLE', 'FETCH_FAILED', 'HTTP_ERROR'] as const),
    httpStatus: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
  }, { additionalProperties: false })),
}, { additionalProperties: false });
export const HostSubscriptionsSchema = Type.Object({
  subscriptions: Type.Array(SubscriptionUsageSchema, { maxItems: 8 }),
}, { additionalProperties: false });
export type SubscriptionProvider = Static<typeof SubscriptionProviderSchema>;
export type SubscriptionUsageWindow = Static<typeof SubscriptionUsageWindowSchema>;
export type SubscriptionUsage = Static<typeof SubscriptionUsageSchema>;
export type HostSubscriptions = Static<typeof HostSubscriptionsSchema>;
