import { Type, type Static } from 'typebox';
import { OPERATION_CATALOG } from './commands.js';
import { ResponseSchema, parseClientEnvelope, parseServerEnvelope, type ClientEnvelope, type Response } from './envelopes.js';
import { ROW_SCHEMA_VERSION, ProtocolValidationError } from './limits.js';
import { CounterSchema, IdSchema, parseSchema } from './schema.js';
import { UUID_V7_PATTERN, requestRetainUntil } from './request-id.js';

export const StoredRequestRecordSchema = Type.Object({
  schemaVersion: Type.Literal(ROW_SCHEMA_VERSION), id: Type.String({ pattern: UUID_V7_PATTERN }), owner: IdSchema,
  session: Type.Optional(IdSchema), admittedAt: CounterSchema, retainUntil: CounterSchema,
  payload: Type.String({ minLength: 1 }),
  state: Type.Union([
    Type.Object({ phase: Type.Literal('intent') }),
    Type.Object({ phase: Type.Literal('dispatched') }),
    Type.Object({ phase: Type.Literal('terminal'), response: ResponseSchema }),
  ]),
});
export type StoredRequestRecord = Static<typeof StoredRequestRecordSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value);
}

function payload(request: ClientEnvelope): object {
  return { op: request.op, ...(request.session === undefined ? {} : { session: request.session }), params: request.params };
}

export function canonicalRequestPayload(value: unknown): string {
  const request = parseClientEnvelope(value);
  return canonical(payload(request));
}

export function compareRequestPayload(previous: unknown | undefined, next: unknown): 'same' | 'conflict' | 'unavailable' {
  const request = parseClientEnvelope(next);
  if (previous === undefined) return 'unavailable';
  const recorded = parseClientEnvelope(previous);
  if (recorded.id !== request.id) return 'conflict';
  return canonical(payload(recorded)) === canonical(payload(request)) ? 'same' : 'conflict';
}

export function parseStoredRequestRecord(value: unknown): StoredRequestRecord {
  const record = parseSchema(StoredRequestRecordSchema, value);
  if (record.retainUntil < requestRetainUntil(record.id, record.admittedAt)) throw new ProtocolValidationError('invalid_request', 'Request retention is shorter than the retry lifetime');
  let raw: unknown;
  try { raw = JSON.parse(record.payload); } catch { throw new ProtocolValidationError('invalid_request', 'Invalid stored command identity'); }
  if (raw === null || typeof raw !== 'object') throw new ProtocolValidationError('invalid_request', 'Invalid stored command identity');
  const request = parseClientEnvelope({ ...raw, v: 1, id: record.id });
  if (!OPERATION_CATALOG[request.op].mutation || request.session !== record.session || canonicalRequestPayload(request) !== record.payload) {
    throw new ProtocolValidationError('invalid_request', 'Invalid durable command identity');
  }
  if (record.state.phase === 'terminal') {
    const rawState = (value as { state: { response: unknown } }).state;
    record.state.response = parseServerEnvelope(rawState.response, request.op) as Response;
    if (record.state.response.re !== record.id) throw new ProtocolValidationError('invalid_request', 'Request outcome identity mismatch');
  }
  return record;
}
