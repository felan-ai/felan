import { Type, type Static } from 'typebox';
import { LIMITS, ProtocolValidationError, utf8Bytes } from './limits.js';
import { AbsolutePathSchema, ClientKindSchema, CounterSchema, CursorSchema, IdSchema, JsonValueSchema, ModelSchema, NameSchema, ThinkingSchema, enumOf, parseSchema, text, type JsonValue } from './schema.js';
import { UiPresentationSchema, parseUiPresentation } from './ui.js';

import { ActiveMessageDisplaySchema } from './message-display.js';

const TranscriptDataSchema = Type.Unsafe<JsonValue>(Type.Unknown({ 'x-jsonValue': true, 'x-maxEncodedBytes': LIMITS.pageBytes }));

export const PromptAttachmentSchema = Type.Union([
  Type.Object({ type: Type.Literal('text'), text: text(LIMITS.promptTextBytes), name: Type.Optional(text(256)) }),
  Type.Object({ type: Type.Literal('image'), mimeType: enumOf(['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const), data: text(LIMITS.attachmentBytes), name: Type.Optional(text(256)) }),
  Type.Object({ type: Type.Literal('resource_link'), uri: text(4096, 1), name: Type.Optional(text(256)), mimeType: Type.Optional(text(256)), description: Type.Optional(text(4096)) }),
]);
export const PromptSchema = Type.Object({ text: text(LIMITS.promptTextBytes), attachments: Type.Optional(Type.Array(PromptAttachmentSchema, { maxItems: LIMITS.attachments })) });
export const OriginSchema = Type.Union([
  Type.Object({ kind: ClientKindSchema, attachment: IdSchema }),
  Type.Object({ kind: Type.Literal('automation'), source: IdSchema, parentRunId: Type.Optional(IdSchema) }),
]);
export const QueueItemSchema = Type.Object({ id: IdSchema, kind: enumOf(['steer', 'follow_up'] as const), prompt: PromptSchema, origin: OriginSchema });
export const RunSchema = Type.Object({
  state: enumOf(['idle', 'running', 'waiting', 'cancelling', 'interrupted'] as const),
  id: Type.Optional(IdSchema), turnId: Type.Optional(IdSchema), origin: Type.Optional(OriginSchema),
});
export const PolicyBlockerSchema = Type.Object({
  session: IdSchema, runId: Type.Optional(IdSchema), toolCallId: Type.Optional(IdSchema),
  reason: enumOf(['turn', 'tool', 'admitted_dispatch'] as const),
});
export const PolicySchema = Type.Object({
  effective: enumOf(['host-default', 'acp-strict'] as const), generation: CounterSchema,
  pending: Type.Optional(Type.Object({ target: Type.Literal('acp-strict'), blockers: Type.Array(PolicyBlockerSchema, { maxItems: LIMITS.pageEntries }) })),
});
export const ToolCatalogEntrySchema = Type.Object({
  name: NameSchema, label: text(1024), description: text(16384), parameters: JsonValueSchema,
  provenance: enumOf(['builtin', 'external'] as const), source: IdSchema, active: Type.Boolean(),
});
export const CommandCatalogEntrySchema = Type.Object({
  name: NameSchema, description: text(16384), source: IdSchema, kind: enumOf(['extension', 'skill'] as const),
  scope: Type.Optional(enumOf(['temporary', 'project', 'user'] as const)),
});
export const CatalogSchema = Type.Object({
  tools: Type.Array(ToolCatalogEntrySchema, { maxItems: LIMITS.catalogEntries }),
  commands: Type.Array(CommandCatalogEntrySchema, { maxItems: LIMITS.catalogEntries }),
  models: Type.Array(Type.Object({ ...ModelSchema.properties, label: text(1024), thinking: Type.Array(ThinkingSchema, { maxItems: 7, uniqueItems: true }) }), { maxItems: LIMITS.catalogEntries }),
  cursor: Type.Optional(CursorSchema),
});
export const ContentSchema = Type.Union([
  Type.Object({ type: Type.Literal('text'), text: text(LIMITS.pageBytes) }),
  Type.Object({ type: Type.Literal('thinking'), text: text(LIMITS.pageBytes) }),
  PromptAttachmentSchema,
  Type.Object({ type: Type.Literal('tool_call'), id: IdSchema, name: NameSchema, arguments: TranscriptDataSchema }),
  Type.Object({ type: Type.Literal('tool_result'), id: IdSchema, text: text(LIMITS.pageBytes), isError: Type.Boolean(), details: Type.Optional(TranscriptDataSchema) }),
]);
export const MessageSchema = Type.Object({
  id: IdSchema, entryId: IdSchema, parentEntryId: Type.Optional(IdSchema),
  role: enumOf(['user', 'assistant', 'tool', 'system', 'custom'] as const),
  content: Type.Array(ContentSchema, { maxItems: LIMITS.pageEntries }),
  timestamp: CounterSchema, customType: Type.Optional(NameSchema), details: Type.Optional(TranscriptDataSchema), origin: Type.Optional(OriginSchema),
}, { 'x-maxEncodedBytes': LIMITS.pageBytes });
export const HistoryPageSchema = Type.Object({
  revision: CounterSchema, branch: IdSchema,
  entries: Type.Array(MessageSchema, { maxItems: LIMITS.pageEntries }), cursor: Type.Optional(CursorSchema),
}, { 'x-maxEncodedBytes': LIMITS.pageBytes });
export const TreePageSchema = Type.Object({
  revision: CounterSchema, branch: IdSchema,
  entries: Type.Array(Type.Object({ id: IdSchema, parent: Type.Optional(IdSchema), kind: NameSchema, role: Type.Optional(NameSchema), label: Type.Optional(text(4096)), summary: text(16384), timestamp: CounterSchema }), { maxItems: LIMITS.pageEntries }),
  cursor: Type.Optional(CursorSchema),
}, { 'x-maxEncodedBytes': LIMITS.pageBytes });
export const ToolStateSchema = Type.Object({
  id: IdSchema, name: NameSchema, message: IdSchema,
  state: enumOf(['running', 'completed', 'failed', 'interrupted'] as const),
  output: text(LIMITS.statusTextBytes), truncated: Type.Boolean(), details: Type.Optional(JsonValueSchema),
});
export const ProcessSchema = Type.Object({
  id: IdSchema, session: IdSchema, root: IdSchema, kind: enumOf(['foreground', 'detached', 'pty'] as const),
  state: enumOf(['running', 'exited', 'missing', 'interrupted'] as const),
  command: text(16384), startedAt: CounterSchema, exitCode: Type.Optional(Type.Integer()),
  controllable: Type.Boolean(), outputOffset: CounterSchema,
});
export const ProcessPageSchema = Type.Object({ entries: Type.Array(ProcessSchema, { maxItems: LIMITS.pageEntries }), cursor: Type.Optional(CursorSchema) }, { 'x-maxEncodedBytes': LIMITS.pageBytes });
export const ChildSchema = Type.Object({ session: IdSchema, parent: IdSchema, root: IdSchema, title: text(4096), run: RunSchema, state: enumOf(['open', 'closed'] as const) });
const UnknownPresentationSchema = Type.Object({ id: IdSchema,
  kind: Type.String({ minLength: 1, maxLength: LIMITS.idBytes, pattern: '^(?!(?:notification|status|title|widget|message_display|progress|document|view)$)[a-z][a-z0-9._@-]*$' }),
  fallback: Type.String({ minLength: 1, maxLength: 4096, 'x-maxBytes': 4096 }),
});
export const PresentationSchema = Type.Union([
  Type.Object({ id: IdSchema, kind: Type.Literal('notification'), level: enumOf(['info', 'warning', 'error'] as const), text: text(LIMITS.statusTextBytes) }, { 'x-maxEncodedBytes': LIMITS.structuredBytes }),
  Type.Object({ id: IdSchema, kind: Type.Literal('title'), text: text(LIMITS.statusTextBytes) }, { 'x-maxEncodedBytes': LIMITS.structuredBytes }),
  Type.Object({ id: IdSchema, kind: Type.Literal('widget'), text: text(LIMITS.statusTextBytes), placement: Type.Optional(enumOf(['aboveEditor', 'belowEditor'] as const)) }, { 'x-maxEncodedBytes': LIMITS.structuredBytes }),
  Type.Object({ id: IdSchema, kind: Type.Literal('message_display'), data: ActiveMessageDisplaySchema }),
  UiPresentationSchema,
], { 'x-maxEncodedBytes': LIMITS.pageBytes });
const sessionSummaryFields = {
  session: IdSchema, root: IdSchema, parent: Type.Optional(IdSchema), cwd: AbsolutePathSchema,
  state: enumOf(['open', 'closed'] as const), residency: enumOf(['warm', 'evicted'] as const),
  title: text(4096), model: Type.Optional(ModelSchema), lastActivity: CounterSchema, run: RunSchema, policy: PolicySchema,
};
export const SessionSummarySchema = Type.Object({ ...sessionSummaryFields, revision: CounterSchema });
export const SessionsPageSchema = Type.Object({ entries: Type.Array(SessionSummarySchema, { maxItems: LIMITS.pageEntries }), cursor: Type.Optional(CursorSchema),
}, { 'x-maxEncodedBytes': LIMITS.pageBytes });
export type Prompt = Static<typeof PromptSchema>;
export type PromptAttachment = Static<typeof PromptAttachmentSchema>;
export type Origin = Static<typeof OriginSchema>;
export type Policy = Static<typeof PolicySchema>;
export type Message = Static<typeof MessageSchema>;
export type Process = Static<typeof ProcessSchema>;
export type Presentation = Static<typeof PresentationSchema>;

export function parsePresentation(value: unknown): Presentation {
  let presentation: Presentation;
  try {
    presentation = parseSchema(PresentationSchema, value);
  } catch (knownError) {
    try {
      const unknown = parseSchema(UnknownPresentationSchema, value);
      return { id: unknown.id, kind: 'notification', level: 'info', text: unknown.fallback };
    } catch {
      throw knownError;
    }
  }
  if (presentation.kind === 'status' || presentation.kind === 'progress' || presentation.kind === 'document' || presentation.kind === 'view') {
    return parseUiPresentation(presentation);
  }
  return presentation;
}

export function validatePrompt(prompt: Prompt): void {
  const textBytes = utf8Bytes(prompt.text) + (prompt.attachments ?? []).reduce((sum, item) => sum + (item.type === 'text' ? utf8Bytes(item.text) : 0), 0);
  if (textBytes > LIMITS.promptTextBytes) throw new ProtocolValidationError('invalid_request', 'Prompt text aggregate limit exceeded');
  if (utf8Bytes(JSON.stringify(prompt.attachments ?? [])) > LIMITS.attachmentBytes) throw new ProtocolValidationError('invalid_request', 'Attachment aggregate limit exceeded');
  for (const attachment of prompt.attachments ?? []) if (attachment.type === 'image') validateBase64(attachment.data, LIMITS.attachmentBytes);
}

export function validateBase64(data: string, maxBytes: number): number {
  if (data.length % 4 !== 0) throw new ProtocolValidationError('invalid_request', 'Invalid base64 data');
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  for (let index = 0; index < data.length - padding; index++) {
    const code = data.charCodeAt(index);
    if ((code < 65 || code > 90) && (code < 97 || code > 122) && (code < 48 || code > 57) && code !== 43 && code !== 47) {
      throw new ProtocolValidationError('invalid_request', 'Invalid base64 data');
    }
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if ((padding === 2 && (alphabet.indexOf(data.at(-3) ?? '') & 15) !== 0) || (padding === 1 && (alphabet.indexOf(data.at(-2) ?? '') & 3) !== 0)) throw new ProtocolValidationError('invalid_request', 'Noncanonical base64 data');
  const bytes = data.length / 4 * 3 - padding;
  if (bytes > maxBytes) throw new ProtocolValidationError('invalid_request', 'Decoded byte limit exceeded');
  return bytes;
}

