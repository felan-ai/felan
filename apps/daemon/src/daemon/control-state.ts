import { isDeepStrictEqual } from 'node:util';
import { Type, type Static, type TSchema } from 'typebox';
import { AbsolutePathSchema, ClientKindSchema, CounterSchema, IdSchema, InteractionSchema, JsonValueSchema, ModelSchema, PolicySchema, RunSchema, ThinkingSchema, UUID_V7_PATTERN, assertJson, parseSchema, enumOf, text, unboundedText } from '@felan-ai/session-protocol';

export const CONTROL_LIMITS = Object.freeze({
  projections: 256,
  projectionAgeMs: 7 * 24 * 60 * 60 * 1000,
});
export class ControlStoreError extends Error {
  constructor(readonly code: 'storage_failure' | 'request_capacity' | 'request_conflict' | 'not_found' | 'already_resolved' | 'invalid_request' | 'ownership_lost', message: string) {
    super(message); this.name = 'ControlStoreError';
  }
}
export const DigestSchema = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const IdentitySchema = Type.Object({ sha256: DigestSchema, bytes: CounterSchema });
export const SessionProfileSchema = Type.Object({
  source: ClientKindSchema, interactiveExtensions: Type.Optional(Type.Boolean()),
  extensionPaths: Type.Optional(Type.Array(AbsolutePathSchema, { uniqueItems: true })),
  extensionConfigOverrides: Type.Optional(Type.Array(Type.Object({ extensionId: IdSchema, source: text(128, 1),
    values: Type.Record(Type.String(), JsonValueSchema),
  }))),
});
export type SessionProfile = Static<typeof SessionProfileSchema>;
const message = Type.Object({ type: Type.Literal('message'), id: IdSchema, entryId: IdSchema, state: enumOf(['observed', 'missing'] as const) });
/** Durable view records: message identities and the pending queue. Tool and status views are live-only. */
const projection = Type.Object({
  key: text(256, 1), updatedAt: CounterSchema,
  value: Type.Union([
    message,
    Type.Object({ type: Type.Literal('queue'), ids: Type.Array(IdSchema, { maxItems: 256 }), identity: IdentitySchema }),
  ]),
});
export const ExecutionMetadataSchema = Type.Object({
  request: Type.Object({
    prompt: unboundedText(1), description: unboundedText(1), appendSystemPrompt: Type.Optional(unboundedText()),
    model: Type.Optional(ModelSchema), thinking: Type.Optional(ThinkingSchema), label: Type.Optional(text(256, 1)),
    maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400_000 })),
    allowChildren: Type.Optional(Type.Boolean()), notifyOnCompletion: Type.Optional(Type.Boolean()),
    excludedTools: Type.Optional(Type.Array(IdSchema, { maxItems: 256 })),
  }),
  createdAt: text(64, 1), startedAt: Type.Optional(text(64, 1)), completedAt: Type.Optional(text(64, 1)),
  outcome: Type.Optional(enumOf(['completed', 'failed', 'timed_out', 'cancelled'] as const)),
  error: Type.Optional(Type.Object({ code: text(128, 1), message: unboundedText() })),
  deliveryId: IdSchema, completionPending: Type.Boolean(),
  message: Type.Optional(unboundedText()),
});
export type ExecutionMetadata = Static<typeof ExecutionMetadataSchema>;

export const ControlSessionSchema = Type.Object({
  id: IdSchema, root: IdSchema, parent: Type.Optional(IdSchema), cwd: AbsolutePathSchema, piPath: AbsolutePathSchema,
  revision: CounterSchema, updatedAt: CounterSchema, state: enumOf(['open', 'closed'] as const), residency: enumOf(['warm', 'evicted'] as const),
  run: RunSchema, policy: PolicySchema, title: unboundedText(), branch: Type.Optional(IdSchema), observedTip: Type.Optional(IdSchema),
  model: Type.Optional(ModelSchema), thinking: Type.Optional(ThinkingSchema),
  profile: Type.Optional(SessionProfileSchema), execution: Type.Optional(ExecutionMetadataSchema),
  deletedAt: Type.Optional(CounterSchema),
  projections: Type.Array(projection, { maxItems: CONTROL_LIMITS.projections }),
});
export const ControlSessionMetadataSchema = Type.Omit(ControlSessionSchema, ['projections']);
export const ControlProjectionRecordSchema = projection;
export type ControlSession = Static<typeof ControlSessionSchema>;
export type ControlSessionMetadata = Omit<ControlSession, 'projections'>;
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
  id: IdSchema, session: IdSchema, root: IdSchema, kind: enumOf(['foreground', 'pty', 'detached'] as const),
  state: enumOf(['running', 'exited', 'interrupted', 'missing', 'reconciling'] as const),
  reference: Type.Optional(AbsolutePathSchema), pid: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647 })),
  startIdentity: Type.Optional(text(128, 1)), updatedAt: CounterSchema,
});
export type ControlResource = Static<typeof ControlResourceSchema>;
export const ControlStateSchema = Type.Object({
  version: Type.Literal(1), namespace: IdSchema, agentDir: AbsolutePathSchema, clock: CounterSchema,
  sessions: Type.Array(ControlSessionSchema),
  requests: Type.Array(ControlRequestSchema),
  interactions: Type.Array(InteractionSchema),
  continuations: Type.Array(ControlContinuationSchema),
  resources: Type.Array(ControlResourceSchema),
}, { additionalProperties: false });
export type ControlState = Omit<Static<typeof ControlStateSchema>, 'requests'> & { requests: ControlRequest[] };

export class ControlStateValidationError extends Error {
  constructor(readonly code: 'unsupported_version' | 'invalid_state') {
    super(code === 'unsupported_version' ? 'Control state version is unsupported.' : 'Control state is invalid.');
    this.name = 'ControlStateValidationError';
  }
}

export function parseControlState(value: unknown): ControlState {
  try {
    checkObject(value);
    if (value.version !== 1) throw new ControlStateValidationError('unsupported_version');
    return parseExact(ControlStateSchema, value) as ControlState;
  } catch (error) {
    if (error instanceof ControlStateValidationError) throw error;
    throw new ControlStateValidationError('invalid_state');
  }
}

const ROW_SCHEMAS = { sessions: ControlSessionMetadataSchema, requests: ControlRequestSchema, interactions: InteractionSchema, continuations: ControlContinuationSchema, resources: ControlResourceSchema, projections: ControlProjectionRecordSchema };
/** Validates one stored record (a session without its projections, or one projection) as `parseControlState` would. */
export function assertControlRow(table: keyof typeof ROW_SCHEMAS, value: unknown): void {
  try { checkObject(value); parseExact(ROW_SCHEMAS[table], value); }
  catch { throw new ControlStateValidationError('invalid_state'); }
}

function parseExact(schema: TSchema, value: unknown): unknown {
  assertJson(value);
  checkJsonProperties(value);
  const parsed = parseSchema(schema, value);
  if (!isDeepStrictEqual(parsed, value)) throw new ControlStateValidationError('invalid_state');
  return parsed;
}

function checkObject(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new ControlStateValidationError('invalid_state');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) throw new ControlStateValidationError('invalid_state');
  }
}

function checkJsonProperties(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) throw new ControlStateValidationError('invalid_state');
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !('value' in descriptor)) throw new ControlStateValidationError('invalid_state');
      checkJsonProperties(descriptor.value);
    }
  } else {
    checkObject(value);
    for (const child of Object.values(value)) checkJsonProperties(child);
  }
}
