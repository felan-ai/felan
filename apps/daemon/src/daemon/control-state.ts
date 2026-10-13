import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Value } from 'typebox/value';
import { Type, type Static } from 'typebox';
import { AbsolutePathSchema, ClientKindSchema, CounterSchema, IdSchema, InteractionSchema, JsonValueSchema, LIMITS, ModelSchema, PolicySchema, RunSchema, ThinkingSchema, ToolStateSchema, UUID_V7_PATTERN, assertJson, parseSchema, enumOf, text } from '@felan-ai/session-protocol';

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
  constructor(readonly code: 'storage_failure' | 'request_capacity' | 'request_conflict' | 'not_found' | 'already_resolved' | 'invalid_request' | 'ownership_lost', message: string) {
    super(message); this.name = 'ControlStoreError';
  }
}
export const DigestSchema = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const IdentitySchema = Type.Object({ sha256: DigestSchema, bytes: CounterSchema });
export const SessionProfileSchema = Type.Object({
  source: ClientKindSchema, interactiveExtensions: Type.Optional(Type.Boolean()),
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
export const ExecutionMetadataSchema = Type.Object({
  request: Type.Object({
    prompt: text(128 * 1024, 1), description: text(512, 1), appendSystemPrompt: Type.Optional(text(128 * 1024)),
    model: Type.Optional(ModelSchema), thinking: Type.Optional(ThinkingSchema), label: Type.Optional(text(256, 1)),
    maxTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 86_400_000 })),
    allowChildren: Type.Optional(Type.Boolean()), notifyOnCompletion: Type.Optional(Type.Boolean()),
    excludedTools: Type.Optional(Type.Array(IdSchema, { maxItems: 256 })),
  }),
  createdAt: text(64, 1), startedAt: Type.Optional(text(64, 1)), completedAt: Type.Optional(text(64, 1)),
  outcome: Type.Optional(enumOf(['completed', 'failed', 'timed_out', 'cancelled'] as const)),
  error: Type.Optional(Type.Object({ code: text(128, 1), message: text(4096) })),
  deliveryId: IdSchema, completionPending: Type.Boolean(),
  message: Type.Optional(text(128 * 1024)),
});
export type ExecutionMetadata = Static<typeof ExecutionMetadataSchema>;

export const ControlSessionSchema = Type.Object({
  id: IdSchema, root: IdSchema, parent: Type.Optional(IdSchema), cwd: AbsolutePathSchema, piPath: AbsolutePathSchema,
  revision: CounterSchema, updatedAt: CounterSchema, state: enumOf(['open', 'closed'] as const), residency: enumOf(['warm', 'evicted'] as const),
  run: RunSchema, policy: PolicySchema, title: text(4096), branch: Type.Optional(IdSchema), observedTip: Type.Optional(IdSchema),
  model: Type.Optional(ModelSchema), thinking: Type.Optional(ThinkingSchema),
  profile: Type.Optional(SessionProfileSchema), execution: Type.Optional(ExecutionMetadataSchema),
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
  id: IdSchema, session: IdSchema, root: IdSchema, kind: enumOf(['foreground', 'pty', 'detached'] as const),
  state: enumOf(['running', 'exited', 'interrupted', 'missing', 'reconciling'] as const),
  reference: Type.Optional(AbsolutePathSchema), pid: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647 })),
  startIdentity: Type.Optional(text(128, 1)), updatedAt: CounterSchema,
});
export type ControlResource = Static<typeof ControlResourceSchema>;
export const CONTROL_CONFIGURATION_SNAPSHOT_MAX_BYTES = LIMITS.structuredBytes;
export const ControlConfigurationSnapshotSchema = Type.Object({
  sessionId: IdSchema,
  snapshot: JsonValueSchema,
  identity: Type.Object(IdentitySchema.properties, { additionalProperties: false }),
}, { additionalProperties: false });
export type ControlConfigurationSnapshot = Static<typeof ControlConfigurationSnapshotSchema>;

export const ControlStateSchema = Type.Object({
  version: Type.Literal(1), namespace: IdSchema, agentDir: AbsolutePathSchema, clock: CounterSchema,
  sessions: Type.Array(ControlSessionSchema, { maxItems: CONTROL_LIMITS.sessions }),
  requests: Type.Array(ControlRequestSchema, { maxItems: CONTROL_LIMITS.requests }),
  interactions: Type.Array(InteractionSchema, { maxItems: CONTROL_LIMITS.interactions }),
  continuations: Type.Array(ControlContinuationSchema, { maxItems: CONTROL_LIMITS.continuations }),
  resources: Type.Array(ControlResourceSchema, { maxItems: CONTROL_LIMITS.resources }),
  configurationSnapshots: Type.Array(ControlConfigurationSnapshotSchema, { maxItems: CONTROL_LIMITS.sessions }),
}, { additionalProperties: false });
export type ControlState = Omit<Static<typeof ControlStateSchema>, 'requests'> & { requests: ControlRequest[] };

type Immutable<T> = Readonly<T>;

export class ControlStateValidationError extends Error {
  constructor(readonly code: 'unsupported_version' | 'invalid_state' | 'snapshot_mismatch') {
    super(code === 'unsupported_version' ? 'Control state version is unsupported.'
      : code === 'snapshot_mismatch' ? 'Control configuration snapshot identity does not match.' : 'Control state is invalid.');
    this.name = 'ControlStateValidationError';
  }
}

export function computeControlConfigurationSnapshotIdentity(snapshot: unknown): Readonly<Static<typeof IdentitySchema>> {
  try {
    assertJson(snapshot, CONTROL_CONFIGURATION_SNAPSHOT_MAX_BYTES);
    checkJsonProperties(snapshot);
    parseSchema(JsonValueSchema, snapshot);
    const canonical = canonicalJson(snapshot);
    return Object.freeze({ sha256: createHash('sha256').update(canonical, 'utf8').digest('hex'), bytes: bytesOfText(canonical) });
  } catch {
    throw new ControlStateValidationError('invalid_state');
  }
}

export function validateControlConfigurationSnapshot(value: unknown): Immutable<ControlConfigurationSnapshot> {
  const snapshot = readConfigurationSnapshot(value);
  const identity = computeControlConfigurationSnapshotIdentity(snapshot.snapshot);
  if (identity.sha256 !== snapshot.identity.sha256 || identity.bytes !== snapshot.identity.bytes) {
    throw new ControlStateValidationError('snapshot_mismatch');
  }
  return snapshot;
}

export function parseControlState(value: unknown): ControlState {
  try {
    checkObject(value);
    if (value.version !== 1) throw new ControlStateValidationError('unsupported_version');
    assertJson(value, CONTROL_LIMITS.bytes);
    checkJsonProperties(value);
    const state = parseSchema(ControlStateSchema, value) as ControlState;
    if (!isDeepStrictEqual(state, value)) throw new ControlStateValidationError('invalid_state');
    return state;
  } catch (error) {
    if (error instanceof ControlStateValidationError) throw error;
    throw new ControlStateValidationError('invalid_state');
  }
}

function readConfigurationSnapshot(value: unknown): Immutable<ControlConfigurationSnapshot> {
  try {
    checkObject(value);
    if (Object.keys(value).some(key => key !== 'sessionId' && key !== 'snapshot' && key !== 'identity')) throw new ControlStateValidationError('invalid_state');
    computeControlConfigurationSnapshotIdentity(value.snapshot);
    parseSchema(IdSchema, value.sessionId);
    parseSchema(IdentitySchema, value.identity);
    checkJsonProperties(value);
    if (!Value.Check(ControlConfigurationSnapshotSchema, value)) throw new ControlStateValidationError('invalid_state');
    return freeze(structuredClone(value)) as Immutable<ControlConfigurationSnapshot>;
  } catch (error) {
    if (error instanceof ControlStateValidationError) throw error;
    throw new ControlStateValidationError('invalid_state');
  }
}

function bytesOfText(value: string): number { return new TextEncoder().encode(value).byteLength; }

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)!;
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
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

function freeze<T>(value: T): Immutable<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as Immutable<T>;
}
