import { createHash } from 'node:crypto';
import { LIMITS, MESSAGE_DISPLAY_KEY, MessageSchema, parseSchema, validateBase64, type JsonValue, type Message, type MessageDisplay } from '@felan-ai/session-protocol';
import { boundMessage } from './message-bounds.js';

const wellFormed = (value: string): string => (value as string & { toWellFormed(): string }).toWellFormed();

export function toolId(input: unknown): string {
  const value = typeof input === 'string' ? input : '';
  if (value && Buffer.byteLength(value) <= LIMITS.idBytes && wellFormed(value) === value) return value;
  return `tool:${createHash('sha256').update(value, 'utf16le').digest('hex')}`;
}

export function toolName(input: unknown): string {
  const value = typeof input === 'string' ? input : '';
  let result = ''; let bytes = 0;
  for (const point of wellFormed(value)) {
    bytes += Buffer.byteLength(point); if (bytes > LIMITS.commandBytes) break;
    result += point;
  }
  return result || 'unknown';
}

export function plainJson(value: unknown): JsonValue {
  const ancestors = new Set<object>();
  function visit(value: unknown, depth: number): JsonValue {
    if (typeof value === 'string') return wellFormed(value);
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value !== 'object') return null;
    // The whole-message pass starts at frame depth five in attach responses; reserve room for the envelope.
    if (depth >= LIMITS.depth - 8) return '[Nested data omitted]';
    if (ancestors.has(value)) return '[Circular data omitted]';
    ancestors.add(value);
    try {
      if ('toJSON' in value && typeof value.toJSON === 'function') return visit(value.toJSON(), depth + 1);
      if (Array.isArray(value)) return Array.from(value, item => visit(item, depth + 1));
      const result: Record<string, JsonValue> = {};
      for (const [key, property] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (key === '__proto__' || !property.enumerable || !('value' in property) || property.value === undefined
          || typeof property.value === 'function' || typeof property.value === 'symbol') continue;
        result[wellFormed(key)] = visit(property.value, depth + 1);
      }
      return result;
    } catch { return '[Unserializable data omitted]'; }
    finally { ancestors.delete(value); }
  }
  return visit(value, 0);
}

function imageContent(part: { mimeType: string; data: string }): Message['content'][number] {
  const mimeType = part.mimeType === 'image/jpg' ? 'image/jpeg' : part.mimeType;
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType)) return { type: 'text', text: '[Image omitted: unsupported format]' };
  try {
    let data = part.data.replace(/\s/g, '');
    if (data.startsWith('data:')) {
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(data);
      if (!match || (match[1] === 'image/jpg' ? 'image/jpeg' : match[1]) !== mimeType) throw new Error('Mismatched image data URI');
      data = match[2]!;
    }
    if (!data) throw new Error('Empty image data');
    validateBase64(data);
    return { type: 'image', mimeType: mimeType as 'image/png', data };
  } catch { return { type: 'text', text: '[Image omitted: invalid data]' }; }
}

export function undisplayableMessage(message: Pick<Message, 'id' | 'entryId' | 'parentEntryId' | 'role' | 'timestamp'>): Message {
  const { id, entryId, parentEntryId, role, timestamp } = message;
  return { id, entryId, ...(parentEntryId ? { parentEntryId } : {}), role, timestamp,
    content: [{ type: 'text', text: '[Message could not be displayed.]' }] };
}

export function sanitizeMessage(value: unknown, fallback: Message, display?: MessageDisplay): Message {
  try {
    const candidate = value as Message;
    const content = candidate.content.map(part => part.type === 'image' ? imageContent(part)
      : part.type === 'tool_call' ? { ...part, id: toolId(part.id), name: toolName(part.name) }
      : part.type === 'tool_result' ? { ...part, id: toolId(part.id) } : part);
    const message = plainJson({ ...candidate, content }) as Message;
    // Tool results also retain their original details on the tool_result part.
    if (display) message.details = message.details !== null && typeof message.details === 'object' && !Array.isArray(message.details)
      ? { ...message.details, [MESSAGE_DISPLAY_KEY]: display } : { [MESSAGE_DISPLAY_KEY]: display };
    if (message.customType !== undefined) message.customType = toolName(message.customType);
    const parsed = parseSchema(MessageSchema, message);
    if (parsed.id !== fallback.id || parsed.entryId !== fallback.entryId) return undisplayableMessage(fallback);
    return boundMessage(parsed);
  } catch { return undisplayableMessage(fallback); }
}

export function catalogEntry<T>(create: () => T): T[] {
  try { return [create()]; } catch { return []; }
}
