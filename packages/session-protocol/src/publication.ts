import { Type, type Static } from 'typebox';
import { ResponseSchema } from './envelopes.js';
import { OperationSchemas } from './commands.js';
import { KnownSessionChangeSchema, parseSessionEvent } from './events.js';
import { INTERACTION_KINDS, InteractionKindSchema } from './interactions.js';
import { LIMITS, PROTOCOL_VERSION, ProtocolValidationError, ROW_SCHEMA_VERSION } from './limits.js';
import { CounterSchema, DiagnosticTextSchema, IdSchema, ModelSchema, NameSchema, ThinkingSchema, enumOf, parseSchema, text } from './schema.js';
import { ChannelProviderSchema, PromptSchema } from './data.js';
import { UUID_V7_PATTERN } from './request-id.js';

export const PUBLISHED_CHANGE_TYPES = [
  'message.completed', 'tool.updated', 'run.updated', 'queue.updated', 'interaction.requested', 'interaction.resolved',
  'metadata.updated', 'model.updated', 'child.updated', 'stream.completion_only',
] as const;
export const PUBLISHED_TOOL_OUTPUT_CHARACTERS = 4096;
export const PUBLICATION_LIMITS = Object.freeze({
  eventsPerBatch: 500,
  batchBytes: 4 * 1024 * 1024,
  changeBytes: 1024 * 1024,
  textChunkBytes: 32 * 1024,
});

const UuidSchema = Type.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' });
const SequenceSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const RemoteOperationSchema = enumOf(['sessions.create', 'prompt', 'steer', 'cancel', 'interaction.answer'] as const);
export const REMOTE_FEATURES = ['sessions.create.instructions'] as const;

export const PublishedEventSchema = Type.Object({
  schemaVersion: Type.Literal(ROW_SCHEMA_VERSION), session: UuidSchema, seq: SequenceSchema,
  rev: SequenceSchema, change: KnownSessionChangeSchema, occurredAt: CounterSchema,
});
export const PublishedSessionSchema = Type.Object({
  schemaVersion: Type.Literal(ROW_SCHEMA_VERSION), session: UuidSchema, parent: Type.Optional(UuidSchema),
  directory: text(256), shared: Type.Boolean(), title: text(1024),
  state: enumOf(['open', 'closed'] as const), runState: enumOf(['idle', 'running', 'waiting', 'cancelling', 'interrupted'] as const),
});
export const HostProjectSchema = Type.Object({ id: IdSchema, name: text(256, 1), path: text(LIMITS.pathBytes, 1) });
export const HostCapabilitiesSchema = Type.Object({
  operations: Type.Array(RemoteOperationSchema, { uniqueItems: true }),
  interactionKinds: Type.Array(InteractionKindSchema, { maxItems: INTERACTION_KINDS.length, uniqueItems: true }),
  features: Type.Optional(Type.Array(IdSchema, { maxItems: 64, uniqueItems: true })),
});
export const HostRegistrationSchema = Type.Object({
  name: text(128, 1), daemonVersion: text(128, 1), rowSchemaVersion: CounterSchema,
  capabilities: HostCapabilitiesSchema, projects: Type.Array(HostProjectSchema, { maxItems: 256 }),
});

export const RemoteCommandSchema = Type.Union([
  Type.Object({ op: Type.Literal('sessions.create'), params: Type.Object({
    project: IdSchema, prompt: Type.Optional(PromptSchema), model: Type.Optional(ModelSchema), thinking: Type.Optional(ThinkingSchema),
    instructions: Type.Optional(text(LIMITS.instructionsBytes, 1)),
  }) }),
  Type.Object({ op: Type.Literal('prompt'), session: UuidSchema, params: OperationSchemas.prompt }),
  Type.Object({ op: Type.Literal('steer'), session: UuidSchema, params: OperationSchemas.steer }),
  Type.Object({ op: Type.Literal('cancel'), session: UuidSchema, params: OperationSchemas.cancel }),
  Type.Object({ op: Type.Literal('interaction.answer'), session: UuidSchema, params: OperationSchemas['interaction.answer'] }),
]);
export const RemoteCommandOutcomeSchema = Type.Union([
  ResponseSchema,
  Type.Object({ v: Type.Literal(PROTOCOL_VERSION), re: IdSchema, outcome: Type.Literal('expired') }),
]);
export const RemoteCommandRowSchema = Type.Object({
  id: Type.String({ pattern: UUID_V7_PATTERN }), host: UuidSchema, requester: UuidSchema,
  command: RemoteCommandSchema, createdAt: CounterSchema, expiresAt: CounterSchema,
  channel: Type.Optional(Type.Object({ provider: ChannelProviderSchema })),
});

export const RealtimeNotificationSchema = Type.Union([
  Type.Object({ event: Type.Literal('command'), payload: Type.Object({ id: Type.String({ pattern: UUID_V7_PATTERN }), op: RemoteOperationSchema }) }),
  Type.Object({ event: Type.Literal('events'), payload: Type.Object({ seq: SequenceSchema }) }),
  Type.Object({ event: Type.Literal('outcome'), payload: Type.Object({ id: Type.String({ pattern: UUID_V7_PATTERN }), state: enumOf(['completed', 'expired'] as const) }) }),
]);

export const HostTokenRequestSchema = Type.Object({
  installId: UuidSchema, name: text(128, 1), daemonVersion: text(128, 1),
  protocol: Type.Literal(PROTOCOL_VERSION), rowSchemaVersion: CounterSchema,
});
export const HostTokenResponseSchema = Type.Object({
  token: Type.String({ minLength: 1 }), expiresAt: CounterSchema, refreshAt: CounterSchema,
  host: Type.Object({ id: UuidSchema, teamId: UuidSchema, userId: UuidSchema }),
  supabase: Type.Object({ url: text(2048, 1), publishableKey: text(256, 1) }),
});
export const HOST_TOKEN_ERROR_CODES = ['invalid_pat', 'not_a_member', 'host_revoked', 'unsupported_schema', 'rate_limited'] as const;
export const HostTokenErrorSchema = Type.Object({
  code: NameSchema, message: DiagnosticTextSchema,
  supported: Type.Optional(Type.Object({ protocol: Type.Array(CounterSchema), rowSchemaVersion: Type.Array(CounterSchema) })),
});
export const HostTokenClaimsSchema = Type.Object({
  iss: text(2048, 1), aud: Type.Literal('authenticated'), role: Type.Literal('authenticated'), sub: UuidSchema,
  iat: CounterSchema, exp: CounterSchema,
  felan: Type.Object({ kind: Type.Literal('host'), host_id: UuidSchema, team_id: UuidSchema, user_id: UuidSchema }),
});

export type PublishedEvent = Static<typeof PublishedEventSchema>;
export type PublishedSession = Static<typeof PublishedSessionSchema>;
export type HostProject = Static<typeof HostProjectSchema>;
export type HostCapabilities = Static<typeof HostCapabilitiesSchema>;
export type HostRegistration = Static<typeof HostRegistrationSchema>;
export type RemoteCommand = Static<typeof RemoteCommandSchema>;
export type RemoteCommandOutcome = Static<typeof RemoteCommandOutcomeSchema>;
export type RemoteCommandRow = Static<typeof RemoteCommandRowSchema>;
export type RealtimeNotification = Static<typeof RealtimeNotificationSchema>;
export type HostTokenRequest = Static<typeof HostTokenRequestSchema>;
export type HostTokenResponse = Static<typeof HostTokenResponseSchema>;
export type HostTokenError = Static<typeof HostTokenErrorSchema>;
export type HostTokenClaims = Static<typeof HostTokenClaimsSchema>;

const published = new Set<string>(PUBLISHED_CHANGE_TYPES);

export function isPublishedChangeType(type: string): type is (typeof PUBLISHED_CHANGE_TYPES)[number] {
  return published.has(type);
}

export function parsePublishedEvent(value: unknown): PublishedEvent {
  const row = parseSchema(PublishedEventSchema, value);
  if (!isPublishedChangeType(row.change.type)) throw new ProtocolValidationError('invalid_request', 'Change type is not published');
  if (row.change.type === 'tool.updated' && Array.from(row.change.tool.output).length > PUBLISHED_TOOL_OUTPUT_CHARACTERS) {
    throw new ProtocolValidationError('invalid_request', 'Published tool output exceeds limit');
  }
  parseSessionEvent({ v: PROTOCOL_VERSION, session: row.session, rev: row.rev, change: row.change });
  return row;
}

export function parsePublishedSession(value: unknown): PublishedSession {
  return parseSchema(PublishedSessionSchema, value);
}

export function parseHostRegistration(value: unknown): HostRegistration {
  const registration = parseSchema(HostRegistrationSchema, value);
  if (new Set(registration.projects.map(project => project.id)).size !== registration.projects.length) {
    throw new ProtocolValidationError('invalid_request', 'Duplicate host project');
  }
  return registration;
}

export function parseRemoteCommand(value: unknown): RemoteCommand {
  return parseSchema(RemoteCommandSchema, value);
}

export function parseRemoteCommandOutcome(value: unknown): RemoteCommandOutcome {
  return parseSchema(RemoteCommandOutcomeSchema, value);
}

export function parseRealtimeNotification(value: unknown): RealtimeNotification {
  return parseSchema(RealtimeNotificationSchema, value);
}

export function parseHostTokenRequest(value: unknown): HostTokenRequest {
  return parseSchema(HostTokenRequestSchema, value);
}

export function parseHostTokenResponse(value: unknown): HostTokenResponse {
  const response = parseSchema(HostTokenResponseSchema, value);
  if (response.refreshAt > response.expiresAt) throw new ProtocolValidationError('invalid_request', 'Token refresh is after expiry');
  return response;
}

export function parseHostTokenClaims(value: unknown): HostTokenClaims {
  const claims = parseSchema(HostTokenClaimsSchema, value);
  if (claims.sub !== claims.felan.host_id) throw new ProtocolValidationError('invalid_request', 'Token subject must be the host');
  if (claims.exp <= claims.iat || claims.exp - claims.iat > 900) throw new ProtocolValidationError('invalid_request', 'Invalid token lifetime');
  return claims;
}
