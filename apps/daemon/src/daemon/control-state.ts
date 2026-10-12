import { Type, type Static } from 'typebox';
import { AbsolutePathSchema, ClientKindSchema, CounterSchema, IdSchema, InteractionSchema, JsonValueSchema, LIMITS, ModelSchema, PolicySchema, RunSchema, ThinkingSchema, ToolStateSchema, UUID_V7_PATTERN, enumOf, text } from '@felan-ai/session-protocol';

export const CONTROL_REQUEST_BUDGET = Object.freeze({ outcome: 1024 * 1024, metadata: 4096, bookkeeping: 1024 });
export const CONTROL_LIMITS = Object.freeze({
  bytes: 16 * 1024 * 1024,
  reserveBytes: CONTROL_REQUEST_BUDGET.outcome + CONTROL_REQUEST_BUDGET.metadata + CONTROL_REQUEST_BUDGET.bookkeeping,
  sessions: 4096,
  requests: 1_000_000, sessionRequests: 100_000, reserveRequests: 1024,
  interactions: 1024, continuations: 1024, resources: 4096, projections: 256,
  projectionAgeMs: 7 * 24 * 60 * 60 * 1000,
});
export class ControlStoreError extends Error {
  constructor(readonly code: 'storage_failure' | 'request_capacity' | 'request_conflict' | 'not_found' | 'already_resolved' | 'invalid_request' | 'adoption_required' | 'ownership_lost', message: string) {
    super(message); this.name = 'ControlStoreError';
  }
}
export const DigestSchema = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const IdentitySchema = Type.Object({ sha256: DigestSchema, bytes: CounterSchema });
export const SessionProfileSchema = Type.Object({
  source: ClientKindSchema,
  extensionPaths: Type.Optional(Type.Array(AbsolutePathSchema, { maxItems: LIMITS.catalogEntries, uniqueItems: true })),
  extensionConfigOverrides: Type.Optional(Type.Array(Type.Object({ extensionId: IdSchema, source: text(128, 1),
    values: Type.Record(Type.String(), JsonValueSchema),
  }), { maxItems: LIMITS.catalogEntries })),
}, { 'x-maxEncodedBytes': LIMITS.pageBytes });
export type SessionProfile = Static<typeof SessionProfileSchema>;
const message = Type.Object({ type: Type.Literal('message'), id: IdSchema, entryId: IdSchema, state: enumOf(['observed', 'missing'] as const) });
const projection = Type.Object({
  key: text(256, 1), updatedAt: CounterSchema,
  value: Type.Union([
    message,
    Type.Object({ type: Type.Literal('tool'), tool: Type.Omit(ToolStateSchema, ['details']) }),
    Type.Object({ type: Type.Literal('status'), id: IdSchema, text: text(16_384) }),
    Type.Object({ type: Type.Literal('queue'), ids: Type.Array(IdSchema, { maxItems: 256 }), identity: IdentitySchema }),
  ]),
});
export const ControlSessionSchema = Type.Object({
  id: IdSchema, root: IdSchema, parent: Type.Optional(IdSchema), cwd: AbsolutePathSchema, piPath: AbsolutePathSchema,
  revision: CounterSchema, updatedAt: CounterSchema, state: enumOf(['open', 'closed'] as const), residency: enumOf(['warm', 'evicted'] as const),
  run: RunSchema, policy: PolicySchema, title: text(4096), branch: Type.Optional(IdSchema), observedTip: Type.Optional(IdSchema),
  model: Type.Optional(ModelSchema), thinking: Type.Optional(ThinkingSchema),
  profile: Type.Optional(SessionProfileSchema),
  deletedAt: Type.Optional(CounterSchema),
  projections: Type.Array(projection, { maxItems: CONTROL_LIMITS.projections }),
});
export type ControlSession = Static<typeof ControlSessionSchema>;
export type ControlProjection = Static<typeof projection>['value'];
export const ControlRequestSchema = Type.Object({
  id: Type.String({ pattern: UUID_V7_PATTERN }), principal: IdSchema, session: Type.Optional(IdSchema), op: IdSchema,
  admittedAt: CounterSchema, retainUntil: CounterSchema, identity: IdentitySchema,
  phase: enumOf(['intent', 'dispatch_intent', 'terminal'] as const), response: Type.Optional(Type.Unknown()),
});
export type ControlRequest = Omit<Static<typeof ControlRequestSchema>, 'response'> & { response?: import('@felan-ai/session-protocol').Response };
export const ControlContinuationSchema = Type.Object({
  id: IdSchema, interaction: IdSchema, session: IdSchema,
  phase: enumOf(['ready', 'dispatch_intent', 'completed', 'indeterminate', 'cancelled'] as const),
  createdAt: CounterSchema, updatedAt: CounterSchema,
});
export type ControlContinuation = Static<typeof ControlContinuationSchema>;
export const ControlResourceSchema = Type.Object({
  id: IdSchema, session: IdSchema, root: IdSchema, kind: enumOf(['child', 'foreground', 'pty', 'detached'] as const),
  state: enumOf(['running', 'exited', 'interrupted', 'missing', 'reconciling'] as const),
  reference: Type.Optional(AbsolutePathSchema), pid: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647 })),
  startIdentity: Type.Optional(text(128, 1)), updatedAt: CounterSchema,
});
export type ControlResource = Static<typeof ControlResourceSchema>;
export const ControlAdoptionSchema = Type.Object({
  id: IdSchema, session: IdSchema, source: AbsolutePathSchema, destination: AbsolutePathSchema,
  fingerprint: DigestSchema, cwd: AbsolutePathSchema, createdAt: CounterSchema,
  phase: enumOf(['copy_intent', 'complete'] as const),
});
export type ControlAdoption = Static<typeof ControlAdoptionSchema>;
export const ControlStateSchema = Type.Object({
  version: Type.Literal(1), namespace: IdSchema, agentDir: AbsolutePathSchema, clock: CounterSchema,
  sessions: Type.Array(ControlSessionSchema, { maxItems: CONTROL_LIMITS.sessions }),
  requests: Type.Array(ControlRequestSchema, { maxItems: CONTROL_LIMITS.requests }),
  interactions: Type.Array(InteractionSchema, { maxItems: CONTROL_LIMITS.interactions }),
  continuations: Type.Array(ControlContinuationSchema, { maxItems: CONTROL_LIMITS.continuations }),
  resources: Type.Array(ControlResourceSchema, { maxItems: CONTROL_LIMITS.resources }),
  adoptions: Type.Array(ControlAdoptionSchema, { maxItems: CONTROL_LIMITS.sessions }),
});
export type ControlState = Omit<Static<typeof ControlStateSchema>, 'requests'> & { requests: ControlRequest[] };
