import { Type, type Static } from 'typebox';
import { LIMITS, ProtocolValidationError } from './limits.js';
import { AbsolutePathSchema, CounterSchema, DiagnosticTextSchema, IdSchema, enumOf, parseSchema, text } from './schema.js';

const RemoteShareSchema = enumOf(['all', 'on-request'] as const);
const RemoteApiUrlSchema = Type.String({ ...text(2048, 1), pattern: '^https?://[^\\s/?#@]+(?:[/?#][^\\s]*)?$' });
// RFC 8628-style user codes: consonants only, so codes are easy to read aloud and cannot spell words.
export const HOST_PAIRING_USER_CODE_PATTERN = '^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$';
export const RemoteConfigureParamsSchema = Type.Union([
  Type.Object({ action: Type.Literal('login'), apiUrl: Type.Optional(RemoteApiUrlSchema) }),
  Type.Object({ action: Type.Literal('logout') }),
  Type.Object({ action: Type.Literal('cancel_pairing') }),
  Type.Object({ action: Type.Literal('share'), share: RemoteShareSchema }),
  Type.Object({ action: Type.Literal('open_project'), path: AbsolutePathSchema, name: Type.Optional(text(256, 1)) }),
  Type.Object({ action: Type.Literal('close_project'), id: IdSchema }),
]);
export type RemoteConfigureParams = Static<typeof RemoteConfigureParamsSchema>;

export const RemoteStatusSchema = Type.Object({
  configured: Type.Boolean(), share: RemoteShareSchema,
  state: enumOf(['off', 'connecting', 'connected', 'offline', 'stopped'] as const),
  reason: Type.Optional(enumOf(['invalid_pat', 'not_a_member', 'host_revoked', 'unsupported_schema', 'rate_limited', 'unavailable', 'pairing_denied', 'pairing_expired'] as const)),
  message: Type.Optional(DiagnosticTextSchema),
  pairing: Type.Optional(Type.Object({
    userCode: Type.String({ pattern: HOST_PAIRING_USER_CODE_PATTERN }),
    verificationUri: text(2048, 1), verificationUriComplete: text(2048, 1), expiresAt: CounterSchema,
  })),
  host: Type.Optional(Type.Object({ id: Type.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' }) })),
  apiUrl: Type.String({ ...RemoteApiUrlSchema, pattern: '^https?://[^\\s/?#@]+$' }),
  projects: Type.Array(Type.Object({ id: IdSchema, name: text(256, 1), path: text(LIMITS.pathBytes, 1) })),
  pending: CounterSchema, sessions: CounterSchema,
  supported: Type.Optional(Type.Object({ protocol: Type.Array(CounterSchema), rowSchemaVersion: Type.Array(CounterSchema) })),
});
export type RemoteStatus = Static<typeof RemoteStatusSchema>;

function validateRemoteApiUrl(value: string, originOnly = false): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new ProtocolValidationError('invalid_request', 'Invalid remote API URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || /[\\\u0000-\u0020\u007f-\u009f]/u.test(value)
    || (originOnly && value !== url.origin)) {
    throw new ProtocolValidationError('invalid_request', 'Invalid remote API URL');
  }
}

export function parseRemoteConfigureParams(value: unknown): RemoteConfigureParams {
  const params = parseSchema(RemoteConfigureParamsSchema, value);
  if (params.action === 'login' && params.apiUrl !== undefined) validateRemoteApiUrl(params.apiUrl);
  return params;
}

export function parseRemoteStatus(value: unknown): RemoteStatus {
  const status = parseSchema(RemoteStatusSchema, value);
  validateRemoteApiUrl(status.apiUrl, true);
  if (status.pairing) {
    validateRemoteApiUrl(status.pairing.verificationUri);
    validateRemoteApiUrl(status.pairing.verificationUriComplete);
  }
  return status;
}
