export { formatMemoryText } from './diagnostics.js';

export const MEMORY_VIEW_PRESENTER = Object.freeze({ id: 'felan.memory', version: '1' });
export const MEMORY_DOCUMENT_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 24 * 1024;
const encoder = new TextEncoder();
export interface MemoryViewRequest {
  viewId: string; sequence: number; documentId: string; kind: 'catalog' | 'snapshot';
  index: number; chunks: number; bytes: number; status: string;
}
export interface MemoryViewChunk { viewId: string; documentId: string; index: number; text: string }
export type MemoryViewChoice =
  { action: 'chunk'; index: number } | { action: 'inspect'; key: string } | { action: 'back' } | { action: 'close' };
export type MemoryViewAction = { viewId: string; sequence: number } & MemoryViewChoice;
export interface MemorySessionView {
  key: string; id: string; path: string; cwd: string; created: number; modified: number; messageCount: number;
  firstMessage: string; allMessagesText: string; name?: string; parentSessionPath?: string;
  project: { canonicalRoot: string; key: string }; manifestPath: string;
}
export interface MemoryMetadataView {
  startedAt: string; finishedAt?: string;
  status: 'started' | 'worker_completed' | 'completed' | 'failed' | 'cancelled' | 'blocked' | 'interrupted';
  phase: 'materialize' | 'model' | 'validate' | 'publish';
  model?: { provider: string; id: string }; error?: string;
}
export type MemoryViewDocument = { kind: 'catalog'; sessions: MemorySessionView[]; current: string[] }
  | { kind: 'snapshot'; session: MemorySessionView; metadata?: MemoryMetadataView; messages: unknown[]; diagnostics: string[] };
function invalid(): never { throw new Error('Invalid memory view data.'); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function id(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(value); }
function count(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max; }
function text(value: unknown, max: number): value is string { return typeof value === 'string' && encoder.encode(value).length <= max; }
function exact(value: Record<string, unknown>, fields: readonly string[]) { if (Object.keys(value).some(key => !fields.includes(key))) invalid(); }

export function parseMemoryViewRequest(value: unknown): MemoryViewRequest {
  if (!record(value)) invalid();
  exact(value, ['viewId', 'sequence', 'documentId', 'kind', 'index', 'chunks', 'bytes', 'status']);
  if (!id(value.viewId) || !id(value.documentId) || !count(value.sequence) || value.sequence === 0
    || value.kind !== 'catalog' && value.kind !== 'snapshot' || !count(value.chunks, 16384) || value.chunks === 0
    || !count(value.index, value.chunks - 1) || !count(value.bytes, MEMORY_DOCUMENT_BYTES) || !text(value.status, 4096)) invalid();
  return { viewId: value.viewId, sequence: value.sequence, documentId: value.documentId, kind: value.kind,
    index: value.index, chunks: value.chunks, bytes: value.bytes, status: value.status };
}

export function parseMemoryViewChunk(value: unknown): MemoryViewChunk {
  if (!record(value)) invalid(); exact(value, ['viewId', 'documentId', 'index', 'text']);
  if (!id(value.viewId) || !id(value.documentId) || !count(value.index, 16383) || !text(value.text, CHUNK_BYTES)
    || encoder.encode(JSON.stringify(value.text)).length > CHUNK_BYTES) invalid();
  return { viewId: value.viewId, documentId: value.documentId, index: value.index, text: value.text };
}

export function parseMemoryViewAction(value: unknown, request: MemoryViewRequest): MemoryViewAction {
  if (!record(value) || value.viewId !== request.viewId || value.sequence !== request.sequence) invalid();
  const base = ['viewId', 'sequence', 'action'];
  if (value.action === 'chunk') { exact(value, [...base, 'index']); if (!count(value.index, request.chunks - 1)) invalid(); }
  else if (value.action === 'inspect') { exact(value, [...base, 'key']); if (request.kind !== 'catalog' || !id(value.key)) invalid(); }
  else if (value.action === 'back' || value.action === 'close') { exact(value, base); }
  else invalid();
  return { ...value } as MemoryViewAction;
}

export function encodeMemoryDocument(document: MemoryViewDocument): { chunks: string[]; bytes: number } {
  const value = JSON.stringify(document); const bytes = encoder.encode(value).length;
  if (bytes > MEMORY_DOCUMENT_BYTES) throw new Error('Memory history exceeds the safe display limit. No retained files were changed.');
  decodeMemoryDocument(value, document.kind);
  const chunks: string[] = []; let chunk = ''; let size = 2;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    const length = code === 34 || code === 92 ? 2 : code < 32 ? 6 : code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
    if (size + length > CHUNK_BYTES) { chunks.push(chunk); chunk = ''; size = 2; }
    chunk += char; size += length;
  }
  chunks.push(chunk); return { chunks, bytes };
}

function session(value: unknown): asserts value is MemorySessionView {
  if (!record(value)) invalid();
  exact(value, ['key', 'id', 'path', 'cwd', 'created', 'modified', 'messageCount', 'firstMessage', 'allMessagesText', 'name', 'parentSessionPath', 'project', 'manifestPath']);
  if (!id(value.key) || !id(value.id) || !text(value.path, 16384) || !text(value.cwd, 16384)
    || !text(value.manifestPath, 16384) || !count(value.created) || !count(value.modified) || !count(value.messageCount)
    || !text(value.firstMessage, 32768) || !text(value.allMessagesText, 256 * 1024)
    || value.name !== undefined && !text(value.name, 8192) || value.parentSessionPath !== undefined && !text(value.parentSessionPath, 16384)
    || !record(value.project) || !text(value.project.canonicalRoot, 16384) || !text(value.project.key, 128)) invalid();
  exact(value.project, ['canonicalRoot', 'key']);
}

export function decodeMemoryDocument(textValue: string, expectedKind: MemoryViewRequest['kind']): MemoryViewDocument {
  if (encoder.encode(textValue).length > MEMORY_DOCUMENT_BYTES) invalid();
  const value: unknown = JSON.parse(textValue);
  if (!record(value) || value.kind !== expectedKind || value.kind !== 'catalog' && value.kind !== 'snapshot') invalid();
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 2_000_000 || item.depth > 64 || typeof item.value === 'number' && !Number.isFinite(item.value)) invalid();
    if (item.value !== null && typeof item.value === 'object') {
      for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
    }
  }
  if (value.kind === 'catalog') {
    exact(value, ['kind', 'sessions', 'current']);
    if (!Array.isArray(value.sessions) || value.sessions.length > 100000 || !Array.isArray(value.current)) invalid();
    value.sessions.forEach(session);
    const keys = new Set(value.sessions.map(row => (row as MemorySessionView).key));
    if (keys.size !== value.sessions.length || !value.current.every(key => id(key) && keys.has(key)) || new Set(value.current).size !== value.current.length) invalid();
  } else {
    exact(value, ['kind', 'session', 'metadata', 'messages', 'diagnostics']); session(value.session);
    if (!Array.isArray(value.messages) || value.messages.length > 250000 || !value.messages.every(message => record(message)
      && text(message.role, 128) && (typeof message.content === 'string' || Array.isArray(message.content)))
      || !Array.isArray(value.diagnostics) || !value.diagnostics.every(line => text(line, 4096))) invalid();
    if (value.metadata !== undefined) {
      const metadata = value.metadata;
      if (!record(metadata)) invalid(); exact(metadata, ['startedAt', 'finishedAt', 'status', 'phase', 'model', 'error']);
      if (!text(metadata.startedAt, 256) || metadata.finishedAt !== undefined && !text(metadata.finishedAt, 256)
        || !['started', 'worker_completed', 'completed', 'failed', 'cancelled', 'blocked', 'interrupted'].includes(metadata.status as string)
        || !['materialize', 'model', 'validate', 'publish'].includes(metadata.phase as string)
        || metadata.error !== undefined && !text(metadata.error, 16384)) invalid();
      if (metadata.model !== undefined) {
        if (!record(metadata.model)) invalid(); exact(metadata.model, ['provider', 'id']);
        if (!text(metadata.model.provider, 4096) || !text(metadata.model.id, 4096)) invalid();
      }
    }
  }
  return value as unknown as MemoryViewDocument;
}
