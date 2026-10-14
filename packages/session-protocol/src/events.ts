import { Type, type Static } from 'typebox';
import { CatalogSchema, ChildSchema, HistoryPageSchema, MessageSchema, PolicySchema, PresentationSchema, ProcessSchema, QueueItemSchema, RunSchema, ToolStateSchema, parsePresentation, validatePrompt } from './data.js';
import { InteractionSchema, parseInteraction } from './interactions.js';
import { LIMITS, PROTOCOL_VERSION, ROW_SCHEMA_VERSION, ProtocolValidationError, codePointLength, utf8Bytes } from './limits.js';
import { AbsolutePathSchema, CounterSchema, CursorSchema, IdSchema, JsonValueSchema, ModelSchema, RevisionSchema, ThinkingSchema, assertJson, enumOf, parseSchema, text, unboundedText } from './schema.js';

export const ActiveStreamSchema = Type.Object({ message: IdSchema, id: IdSchema, kind: enumOf(['assistant', 'thinking'] as const), text: text(LIMITS.activeStreamBytes), offset: CounterSchema });
export const CompletionOnlyStreamSchema = Type.Object({ message: IdSchema, id: IdSchema, kind: enumOf(['assistant', 'thinking'] as const), reason: enumOf(['limit', 'lost'] as const) });
export const SessionSnapshotSchema = Type.Object({
  session: IdSchema, root: IdSchema, parent: Type.Optional(IdSchema), revision: RevisionSchema,
  cwd: AbsolutePathSchema, title: unboundedText(), state: enumOf(['open', 'closed'] as const), residency: enumOf(['warm', 'evicted'] as const),
  branch: IdSchema, history: HistoryPageSchema, model: ModelSchema, thinking: ThinkingSchema,
  queue: Type.Array(QueueItemSchema), run: RunSchema, catalog: CatalogSchema,
  policy: PolicySchema, interactions: Type.Array(InteractionSchema),
  children: Type.Array(ChildSchema), processes: Type.Array(ProcessSchema),
  tools: Type.Array(ToolStateSchema), presentation: Type.Array(PresentationSchema),
  activeStreams: Type.Array(ActiveStreamSchema, { maxItems: LIMITS.activeStreams }),
  completionOnlyStreams: Type.Array(CompletionOnlyStreamSchema, { maxItems: LIMITS.activeStreams }),
  cursor: Type.Optional(CursorSchema),
  executionsGeneration: Type.Optional(text(64, 64)),
});
const changes = [
  Type.Object({ type: Type.Literal('message.completed'), message: MessageSchema }),
  Type.Object({ type: Type.Literal('tool.updated'), tool: ToolStateSchema }),
  Type.Object({ type: Type.Literal('run.updated'), run: RunSchema }),
  Type.Object({ type: Type.Literal('queue.updated'), queue: Type.Array(QueueItemSchema) }),
  Type.Object({ type: Type.Literal('interaction.requested'), interaction: InteractionSchema }),
  Type.Object({ type: Type.Literal('interaction.resolved'), interaction: InteractionSchema }),
  Type.Object({ type: Type.Literal('metadata.updated'), title: unboundedText(), state: enumOf(['open', 'closed'] as const), residency: enumOf(['warm', 'evicted'] as const) }),
  Type.Object({ type: Type.Literal('model.updated'), model: ModelSchema, thinking: ThinkingSchema }),
  Type.Object({ type: Type.Literal('branch.updated'), branch: IdSchema, history: HistoryPageSchema }),
  Type.Object({ type: Type.Literal('policy.updated'), policy: PolicySchema }),
  Type.Object({ type: Type.Literal('child.updated'), child: ChildSchema }),
  Type.Object({ type: Type.Literal('executions.changed'), generation: text(64, 64) }),
  Type.Object({ type: Type.Literal('process.updated'), process: ProcessSchema }),
  Type.Object({ type: Type.Literal('presentation.updated'), presentation: PresentationSchema }),
  Type.Object({ type: Type.Literal('presentation.removed'), id: IdSchema }),
  Type.Object({ type: Type.Literal('catalog.updated'), catalog: CatalogSchema }),
  Type.Object({ type: Type.Literal('stream.completion_only'), stream: CompletionOnlyStreamSchema }),
] as const;
export const KNOWN_CHANGE_TYPES = changes.map(schema => schema.properties.type.const);
export const KnownSessionChangeSchema = Type.Union([...changes]);
export const UnknownSessionChangeSchema = Type.Object({
  type: Type.String({ minLength: 1, maxLength: LIMITS.commandBytes, pattern: `^(?!(?:${KNOWN_CHANGE_TYPES.map(name => name.replaceAll('.', '\\.')).join('|')})$).+$` }),
}, { additionalProperties: JsonValueSchema });
export const SessionChangeSchema = Type.Union([KnownSessionChangeSchema, UnknownSessionChangeSchema]);
export const SessionEventSchema = Type.Object({ v: Type.Literal(PROTOCOL_VERSION), session: IdSchema, rev: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), change: SessionChangeSchema });
export const TextStreamEventSchema = Type.Object({
  v: Type.Literal(PROTOCOL_VERSION), session: IdSchema,
  stream: Type.Object({ message: IdSchema, id: IdSchema, kind: enumOf(['assistant', 'thinking'] as const), offset: CounterSchema }),
  text: text(LIMITS.activeStreamBytes),
});
export const StoredEventRowSchema = Type.Object({ schemaVersion: Type.Literal(ROW_SCHEMA_VERSION), session: IdSchema, rev: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), change: SessionChangeSchema });
export type SessionSnapshot = Static<typeof SessionSnapshotSchema>;
export type SessionEvent = Static<typeof SessionEventSchema>;
export type KnownSessionChange = Static<typeof KnownSessionChangeSchema>;
export type TextStreamEvent = Static<typeof TextStreamEventSchema>;
export type StoredEventRow = Static<typeof StoredEventRowSchema>;

export function parseSessionSnapshot(value: unknown): SessionSnapshot {
  assertJson(value);
  let candidate = value;
  if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) {
    const rows = Reflect.get(candidate, 'presentation');
    if (Array.isArray(rows)) candidate = { ...candidate, presentation: rows.map(parsePresentation) };
  }
  const snapshot = parseSchema(SessionSnapshotSchema, candidate);
  if (snapshot.history.revision !== snapshot.revision || snapshot.history.branch !== snapshot.branch) throw new ProtocolValidationError('invalid_request', 'Snapshot history cutover mismatch');
  const streams = [...snapshot.activeStreams, ...snapshot.completionOnlyStreams];
  if (streams.length > LIMITS.activeStreams || new Set(streams.map(stream => stream.id)).size !== streams.length) throw new ProtocolValidationError('invalid_request', 'Invalid snapshot stream identities');
  if (snapshot.activeStreams.reduce((sum, stream) => sum + utf8Bytes(stream.text), 0) > LIMITS.activeStreamsBytes) throw new ProtocolValidationError('invalid_request', 'Active stream aggregate limit exceeded');
  for (const stream of snapshot.activeStreams) if (codePointLength(stream.text) !== stream.offset) throw new ProtocolValidationError('invalid_request', 'Snapshot stream is not a complete prefix');
  for (const interaction of snapshot.interactions) parseInteraction(interaction);
  for (const presentation of snapshot.presentation) parsePresentation(presentation);
  for (const item of snapshot.queue) validatePrompt(item.prompt);
  if (new Set(snapshot.queue.map(item => item.id)).size !== snapshot.queue.length) throw new ProtocolValidationError('invalid_request', 'Duplicate queue item');
  return snapshot;
}

export function parseSessionEvent(value: unknown): SessionEvent {
  assertJson(value);
  let candidate = value;
  if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) {
    const change = Reflect.get(candidate, 'change');
    if (change !== null && typeof change === 'object' && !Array.isArray(change) && Reflect.get(change, 'type') === 'presentation.updated') {
      const presentation = Reflect.get(change, 'presentation');
      candidate = { ...candidate, change: { ...change, presentation: parsePresentation(presentation) } };
    }
  }
  const event = parseSchema(SessionEventSchema, candidate);
  const change = event.change;
  if (change.type === 'interaction.requested' || change.type === 'interaction.resolved') {
    const interaction = parseInteraction('interaction' in change ? change.interaction : undefined);
    const terminal = ['answered', 'cancelled', 'expired'].includes(interaction.state);
    if ((change.type === 'interaction.resolved') !== terminal) throw new ProtocolValidationError('invalid_request', 'Interaction event state mismatch');
  }
  if (change.type === 'presentation.updated' && 'presentation' in change) parsePresentation(change.presentation);
  if (change.type === 'queue.updated' && 'queue' in change && Array.isArray(change.queue)) {
    for (const item of change.queue) validatePrompt(item.prompt);
    if (new Set(change.queue.map(item => item.id)).size !== change.queue.length) throw new ProtocolValidationError('invalid_request', 'Duplicate queue item');
  }
  return event;
}

export function parseStoredEventRow(value: unknown): StoredEventRow {
  const row = parseSchema(StoredEventRowSchema, value);
  parseSessionEvent({ v: PROTOCOL_VERSION, session: row.session, rev: row.rev, change: row.change });
  return row;
}

export function classifyRevision(current: number, incoming: number): 'next' | 'duplicate' | 'gap' {
  parseSchema(RevisionSchema, current);
  parseSchema(RevisionSchema, incoming);
  return incoming <= current ? 'duplicate' : incoming === current + 1 ? 'next' : 'gap';
}

export function classifyTextDelta(
  prefix: Static<typeof ActiveStreamSchema> | undefined,
  value: unknown,
  state: 'active' | 'completion_only' | 'completed' = 'active',
): 'start' | 'append' | 'duplicate' | 'gap' | 'ignore' {
  const delta = parseSchema(TextStreamEventSchema, value);
  if (state === 'completion_only' || state === 'completed') return 'ignore';
  if (!prefix || prefix.id !== delta.stream.id || prefix.message !== delta.stream.message || prefix.kind !== delta.stream.kind) {
    return delta.stream.offset === 0 ? 'start' : 'gap';
  }
  if (delta.stream.offset === prefix.offset) return 'append';
  const end = delta.stream.offset + codePointLength(delta.text);
  if (end <= prefix.offset) {
    const previous = prefix.text.length === prefix.offset ? prefix.text.slice(delta.stream.offset, end) : Array.from(prefix.text).slice(delta.stream.offset, end).join('');
    if (previous === delta.text) return 'duplicate';
  }
  return 'gap';
}
