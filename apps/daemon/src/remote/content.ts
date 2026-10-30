import { basename } from 'node:path';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import {
  KnownSessionChangeSchema, PUBLISHED_CHANGE_TYPES, PUBLISHED_TOOL_OUTPUT_CHARACTERS, PUBLICATION_LIMITS, ROW_SCHEMA_VERSION,
  isPublishedChangeType, parsePublishedEvent, parsePublishedSession,
  type KnownSessionChange, type PublishedEvent, type PublishedSession, type SessionSnapshot,
} from '@felan-ai/session-protocol';
import { redact } from '../logger.js';

export type PublishedChange = Extract<KnownSessionChange, { type: typeof PUBLISHED_CHANGE_TYPES[number] }>;
export interface PublicationEntry { seq: number; rev: number; occurredAt: number; change: PublishedChange }
export type PublishedSessionInput = Pick<SessionSnapshot, 'session' | 'parent' | 'cwd' | 'title' | 'state' | 'run'> & { shared: boolean; lastActivity?: number };

type Schema = TSchema & {
  anyOf?: Schema[]; properties?: Record<string, Schema>; items?: Schema; minLength?: number; maxLength?: number;
  enum?: unknown[]; const?: unknown; 'x-jsonValue'?: boolean; 'x-maxBytes'?: number;
  patternProperties?: Record<string, Schema>; additionalProperties?: boolean | Schema;
};
type ObjectValue = Record<string, unknown>;
interface TextLeaf { parent: ObjectValue; key: string; min: number; value: string; order: number }
const identityKeys = new Set(['id', 'entryId', 'parentEntryId', 'session', 'root', 'parent', 'message', 'turnId', 'toolCallId', 'optionId', 'choices', 'responder', 'attachment', 'user', 'command', 'source', 'actionId', 'dependency']);

function prefix(value: string, length: number): string {
  if (length > 0 && /[\uD800-\uDBFF]/u.test(value[length - 1]!)) length--;
  return value.slice(0, length);
}

function boundedPrefix(value: string, bytes: number, encoded = false): string {
  const size = (text: string) => Buffer.byteLength(encoded ? JSON.stringify(text) : text);
  if (size(value) <= bytes) return value;
  let low = 0; let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (size(prefix(value, middle)) <= bytes) low = middle;
    else high = middle - 1;
  }
  return prefix(value, low);
}

function branch(schema: Schema, value: unknown): Schema {
  return schema.anyOf?.find(candidate => Value.Check(candidate, value)) ?? schema;
}

function childSchema(schema: Schema, key: string): Schema {
  return schema.properties?.[key] ?? Object.entries(schema.patternProperties ?? {}).find(([pattern]) => new RegExp(pattern).test(key))?.[1]
    ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : schema);
}

function sanitize(schema: Schema, value: unknown, key = '', free = false): unknown {
  const node = branch(schema, value);
  free ||= node['x-jsonValue'] === true;
  if (typeof value === 'string') {
    if (!free && (Object.hasOwn(node, 'const') || node.enum)) return value;
    // Protocol identities must keep matching across requests, answers and later events.
    if (!free && node['x-maxBytes'] === 128 && identityKeys.has(key)) return value;
    const secret = /^(?:[\w-]*(?:api[_-]?key|token|secret|password|authorization|credential)[\w-]*)$/iu.test(key);
    const redacted = secret ? '[redacted]' : redact(value);
    return boundedPrefix(redacted, node['x-maxBytes'] ?? Number.MAX_SAFE_INTEGER);
  }
  if (Array.isArray(value)) return value.map(item => sanitize(node.items ?? node, item, key, free));
  if (value !== null && typeof value === 'object') {
    const record = value as ObjectValue;
    if (record.type === 'image' && typeof record.data === 'string') return { type: 'text', text: '[image omitted]' };
    return Object.fromEntries(Object.entries(record).map(([name, child]) => [name, sanitize(childSchema(node, name), child, name, free)]));
  }
  return value;
}

function textLeaves(schema: Schema, value: unknown, result: TextLeaf[] = [], free = false): TextLeaf[] {
  const node = branch(schema, value);
  free ||= node['x-jsonValue'] === true;
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const field = Array.isArray(value) ? node.items ?? node : childSchema(node, key);
      const selected = branch(field, child);
      if (typeof child === 'string' && (free || (!Object.hasOwn(selected, 'const') && !selected.enum && selected['x-maxBytes'] === undefined))) {
        result.push({ parent: value as ObjectValue, key, value: child, min: free ? 0 : selected.minLength ?? 0, order: result.length });
      } else textLeaves(field, child, result, free);
    }
  }
  return result;
}

function fit(change: PublishedChange): PublishedChange {
  let bytes = Buffer.byteLength(JSON.stringify(change));
  if (bytes <= PUBLICATION_LIMITS.changeBytes) return change;
  const leaves = textLeaves(KnownSessionChangeSchema as Schema, change)
    .sort((a, b) => Buffer.byteLength(JSON.stringify(b.value)) - Buffer.byteLength(JSON.stringify(a.value)) || a.order - b.order);
  for (const leaf of leaves) {
    const current = Buffer.byteLength(JSON.stringify(leaf.value));
    const minimum = Array.from(leaf.value).slice(0, leaf.min).join('');
    const budget = Math.max(Buffer.byteLength(JSON.stringify(minimum)), current - (bytes - PUBLICATION_LIMITS.changeBytes));
    const next = boundedPrefix(leaf.value, budget, true);
    leaf.parent[leaf.key] = next;
    bytes -= current - Buffer.byteLength(JSON.stringify(next));
    if (bytes <= PUBLICATION_LIMITS.changeBytes) return change;
  }
  // No schema-valid text reduction can represent arbitrarily large structural payloads.
  throw new Error('Published change has too much non-text structure to fit the publication limit.');
}

export function publishableChange(change: KnownSessionChange): PublishedChange | undefined {
  if (!isPublishedChangeType(change.type)) return undefined;
  const sanitized = sanitize(KnownSessionChangeSchema as Schema, change) as PublishedChange;
  if (sanitized.type === 'tool.updated') {
    const output = Array.from(sanitized.tool.output);
    if (output.length > PUBLISHED_TOOL_OUTPUT_CHARACTERS) {
      sanitized.tool.output = output.slice(0, PUBLISHED_TOOL_OUTPUT_CHARACTERS).join(''); sanitized.tool.truncated = true;
    }
  }
  return publishedEvent('00000000-0000-0000-0000-000000000000', { seq: 1, rev: 1, occurredAt: 0, change: fit(sanitized) }).change as PublishedChange;
}

export function publishedEvent(session: string, entry: PublicationEntry): PublishedEvent {
  if (Buffer.byteLength(JSON.stringify(entry.change)) > PUBLICATION_LIMITS.changeBytes) throw new Error('Published change exceeds its byte limit.');
  return parsePublishedEvent({ schemaVersion: ROW_SCHEMA_VERSION, session, seq: entry.seq, rev: entry.rev, occurredAt: entry.occurredAt, change: entry.change });
}

export function publishedSession(input: PublishedSessionInput): PublishedSession {
  return parsePublishedSession({
    schemaVersion: ROW_SCHEMA_VERSION, session: input.session, ...(input.parent ? { parent: input.parent } : {}),
    directory: boundedPrefix(redact(basename(input.cwd)), 256), shared: input.shared,
    title: boundedPrefix(redact(input.title), 1024), state: input.state, runState: input.run.state,
    ...(input.lastActivity !== undefined ? { lastActivity: input.lastActivity } : {}),
  });
}
