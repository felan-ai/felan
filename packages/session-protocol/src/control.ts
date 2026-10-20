import { Type, type Static } from 'typebox';
import { CONTROL_VERSION, ProtocolValidationError } from './limits.js';
import { DaemonIdentitySchema, DiagnosticTextSchema, HostBlockedSchema, IdSchema, NameSchema, enumOf, parseSchema, text } from './schema.js';
import { requestTimestamp } from './request-id.js';

export const BootstrapHelloSchema = Type.Object({
  v: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), id: IdSchema, op: Type.Literal('hello'),
  params: Type.Object({ protocol: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), clientVersion: text(128, 1) }),
});
const identity = { expected: DaemonIdentitySchema };
export const ControlRequestSchema = Type.Union([
  Type.Object({ control: Type.Literal(CONTROL_VERSION), id: IdSchema, op: Type.Literal('host.status'), params: Type.Object(identity, { additionalProperties: false }) }, { additionalProperties: false }),
  Type.Object({ control: Type.Literal(CONTROL_VERSION), id: IdSchema, op: enumOf(['host.stop', 'host.restart'] as const),
    params: Type.Object({ ...identity, mode: enumOf(['drain', 'force'] as const) }, { additionalProperties: false }) }, { additionalProperties: false }),
]);
export const ControlResponseSchema = Type.Object({
  control: Type.Literal(CONTROL_VERSION), re: IdSchema, daemonVersion: text(128, 1), supportedProtocol: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), identity: DaemonIdentitySchema,
  state: enumOf(['starting', 'ready', 'draining', 'stopped', 'blocked'] as const), blocked: Type.Optional(HostBlockedSchema),
  outcome: enumOf(['mismatch', 'accepted', 'rejected'] as const),
  error: Type.Optional(Type.Object({ code: NameSchema, message: DiagnosticTextSchema, retryable: Type.Boolean() })),
});
export type ControlRequest = Static<typeof ControlRequestSchema>;
export type ControlResponse = Static<typeof ControlResponseSchema>;

export function parseControlRequest(value: unknown): ControlRequest {
  const request = parseSchema(ControlRequestSchema, value);
  if (request.op !== 'host.status') requestTimestamp(request.id);
  return request;
}

export function parseControlResponse(value: unknown): ControlResponse {
  const response = parseSchema(ControlResponseSchema, value);
  if ((response.outcome === 'rejected') !== (response.error !== undefined)) throw new ProtocolValidationError('invalid_request', 'Control response outcome mismatch');
  return response;
}
