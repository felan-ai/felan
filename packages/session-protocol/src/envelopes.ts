import { Type, type Static } from 'typebox';
import { OPERATION_CATALOG, OperationSchemas, ResultSchemas, type Operation, type OperationParams, type OperationResult } from './commands.js';
import { validateBase64, validatePrompt } from './data.js';
import { SessionEventSchema, TextStreamEventSchema, parseSessionEvent, parseSessionSnapshot } from './events.js';
import { InteractionSchema, parseInteraction } from './interactions.js';
import { LIMITS, PROTOCOL_VERSION, ProtocolValidationError } from './limits.js';
import { CounterSchema, DiagnosticTextSchema, IdSchema, NameSchema, assertJson, enumOf, parseSchema } from './schema.js';
import { requestTimestamp, UUID_V7_PATTERN } from './request-id.js';
import { PresentationEventSchema } from './presentation.js';

export const ERROR_CODES = Object.freeze(['invalid_request', 'unsupported_operation', 'protocol_mismatch', 'unavailable', 'authentication_required', 'busy',
  'request_conflict', 'stale_request', 'expired', 'not_found', 'forbidden', 'already_resolved', 'storage_failure',
  'ownership_lost', 'resync_required', 'indeterminate', 'request_capacity', 'target_mismatch'] as const);
export type KnownErrorCode = (typeof ERROR_CODES)[number];
export const ErrorCodeSchema = NameSchema;
export const ProtocolErrorSchema = Type.Object({
  code: ErrorCodeSchema, message: DiagnosticTextSchema, retryable: Type.Boolean(),
});
export type ClientEnvelope = { [O in Operation]: {
  v: typeof PROTOCOL_VERSION; id: string; op: O; params: OperationParams<O>;
} & (typeof OPERATION_CATALOG[O]['scope'] extends 'session' ? { session: string }
  : typeof OPERATION_CATALOG[O]['scope'] extends 'host' ? { session?: never } : { session?: string }) }[Operation];
export const ClientEnvelopeSchema = Type.Unsafe<ClientEnvelope>(Type.Union(Object.entries(OperationSchemas).map(([op, params]) => Type.Object({
  v: Type.Literal(PROTOCOL_VERSION), id: OPERATION_CATALOG[op as Operation].mutation ? Type.String({ pattern: UUID_V7_PATTERN }) : IdSchema, op: Type.Literal(op as Operation),
  ...(OPERATION_CATALOG[op as Operation].scope === 'session' ? { session: IdSchema }
    : OPERATION_CATALOG[op as Operation].scope === 'either' ? { session: Type.Optional(IdSchema) } : {}), params,
}))));

const AcceptedResponseHeaderSchema = Type.Object({ v: Type.Literal(PROTOCOL_VERSION), re: IdSchema, outcome: Type.Literal('accepted') });
const RejectedResponseSchema = Type.Object({ v: Type.Literal(PROTOCOL_VERSION), re: IdSchema, outcome: enumOf(['rejected', 'indeterminate'] as const), error: ProtocolErrorSchema });
export const ResponseSchema = Type.Union([
  Type.Object({ ...AcceptedResponseHeaderSchema.properties, result: Type.Unsafe<OperationResult<Operation>>(Type.Union(Object.values(ResultSchemas))) }),
  RejectedResponseSchema,
]);
export const InteractionNotificationSchema = Type.Object({ v: Type.Literal(PROTOCOL_VERSION), interaction: InteractionSchema });
export const ServerEnvelopeSchema = Type.Union([ResponseSchema, SessionEventSchema, TextStreamEventSchema, InteractionNotificationSchema, PresentationEventSchema]);
export type ProtocolError = Static<typeof ProtocolErrorSchema>;
export type Response = Static<typeof ResponseSchema>;
export type ServerEnvelope = Static<typeof ServerEnvelopeSchema>;
export type ResponseFor<O extends Operation> = { v: 1; re: string; outcome: 'accepted'; result: OperationResult<O> } |
  { v: 1; re: string; outcome: 'rejected' | 'indeterminate'; error: ProtocolError };

export function parseClientEnvelope(value: unknown): ClientEnvelope {
  assertEnumerableData(value);
  assertJson(value);
  if (value !== null && typeof value === 'object') {
    const operation = Object.getOwnPropertyDescriptor(value, 'op')?.value;
    const params: unknown = Object.getOwnPropertyDescriptor(value, 'params')?.value;
    if (operation === 'config.set' && params !== null && typeof params === 'object' && Object.hasOwn(params, 'expectedRevision')) {
      throw new ProtocolValidationError('invalid_request', 'config.set.expectedRevision is obsolete; configuration uses locked field merges');
    }
  }
  if (value !== null && typeof value === 'object' && 'v' in value && value.v !== PROTOCOL_VERSION) throw new ProtocolValidationError('protocol_mismatch', 'Unsupported protocol version');
  const parsed = parseSchema(ClientEnvelopeSchema, value);
  const definition = OPERATION_CATALOG[parsed.op];
  if (definition.scope === 'host' && value !== null && typeof value === 'object' && 'session' in value) throw new ProtocolValidationError('invalid_request', 'Host operation must not name a session');
  if (definition.mutation) {
    requestTimestamp(parsed.id);
    parsed.id = parsed.id.toLowerCase();
  }
  if (parsed.op === 'prompt' || parsed.op === 'steer' || parsed.op === 'follow_up') validatePrompt(parsed.params);
  if (parsed.op === 'queue.update') {
    const ids = parsed.params.edits.map(edit => edit.id);
    if (new Set(ids).size !== ids.length) throw new ProtocolValidationError('invalid_request', 'Duplicate queue edit');
    for (const edit of parsed.params.edits) if (edit.op === 'replace') validatePrompt(edit.prompt);
  }
  if (parsed.op === 'processes.write') validateBase64(parsed.params.data, LIMITS.processWriteBytes);
  if (parsed.op === 'config.set' && Object.keys(parsed.params.values).length === 0) throw new ProtocolValidationError('invalid_request', 'Empty configuration update');
  if ((parsed.op === 'config.get' || parsed.op === 'config.set') && parsed.params.scope === 'session' && !parsed.session) throw new ProtocolValidationError('invalid_request', 'Session configuration requires a session');
  return parsed;
}

function assertEnumerableData(value: unknown, seen = new Set<object>(), depth = 0): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  if (depth > LIMITS.depth) throw new ProtocolValidationError('invalid_request', 'JSON nesting limit exceeded');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new ProtocolValidationError('invalid_request', 'Expected plain JSON objects');
  seen.add(value);
  if (Object.getOwnPropertySymbols(value).length) throw new ProtocolValidationError('invalid_request', 'Expected JSON data properties');
  for (const key of Object.getOwnPropertyNames(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const property = Object.getOwnPropertyDescriptor(value, key)!;
    if (!property.enumerable || !('value' in property)) throw new ProtocolValidationError('invalid_request', 'Expected JSON data properties');
    assertEnumerableData(property.value, seen, depth + 1);
  }
}

export function parseOperationResult<O extends Operation>(operation: O, value: unknown): OperationResult<O> {
  const result = parseSchema(ResultSchemas[operation], value);
  if (operation === 'attach') parseSessionSnapshot((result as OperationResult<'attach'>).snapshot);
  if (operation === 'processes.read') {
    const read = result as OperationResult<'processes.read'>;
    const bytes = validateBase64(read.data, LIMITS.processReadBytes);
    if (read.nextOffset !== read.offset + bytes) throw new ProtocolValidationError('invalid_request', 'Process output offset mismatch');
  }
  return result;
}

export function parseServerEnvelope(value: unknown, responseOperation?: Operation): ServerEnvelope {
  if (value !== null && typeof value === 'object' && 'v' in value && value.v !== PROTOCOL_VERSION) throw new ProtocolValidationError('protocol_mismatch', 'Unsupported protocol version');
  if (value !== null && typeof value === 'object' && 're' in value) {
    if ('outcome' in value && value.outcome === 'accepted') {
      if (!responseOperation) throw new ProtocolValidationError('invalid_request', 'Accepted responses require the outstanding request operation');
      const response = parseSchema(AcceptedResponseHeaderSchema, value);
      return { ...response, result: parseOperationResult(responseOperation, 'result' in value ? value.result : undefined) } as ServerEnvelope;
    }
    return parseSchema(RejectedResponseSchema, value);
  }
  if (value !== null && typeof value === 'object' && 'stream' in value) return parseSchema(TextStreamEventSchema, value);
  if (value !== null && typeof value === 'object' && 'presentationEvent' in value) return parseSchema(PresentationEventSchema, value);
  if (value !== null && typeof value === 'object' && 'interaction' in value) {
    const notification = parseSchema(InteractionNotificationSchema, value);
    const interaction = parseInteraction(notification.interaction);
    if (interaction.scope.kind !== 'host') {
      throw new ProtocolValidationError('invalid_request', 'Session interactions require the revisioned event stream');
    }
    return notification;
  }
  return parseSessionEvent(value);
}
