import { expect, it } from 'vitest';
import { decodeMemoryDocument, encodeMemoryDocument, parseMemoryViewAction, parseMemoryViewChunk, parseMemoryViewRequest,
  type MemorySessionView, type MemoryViewDocument } from '../src/view.js';

const session: MemorySessionView = { key: 'key', id: 'run', path: '/sessions/run.jsonl', cwd: '/work', created: 1, modified: 2,
  messageCount: 1, firstMessage: 'hello', allMessagesText: 'hello', project: { canonicalRoot: '/work', key: 'project' }, manifestPath: '/memory/manifest.json' };
const request = { viewId: 'view', sequence: 1, documentId: 'document', kind: 'snapshot' as const, index: 0, chunks: 2, bytes: 30000, status: 'ready' };

it('transfers a large Unicode transcript in bounded coherent chunks without truncation', () => {
  const document: MemoryViewDocument = { kind: 'snapshot', session, messages: [{ role: 'user', content: '💚\\\n'.repeat(50000) }], diagnostics: [] };
  const encoded = encodeMemoryDocument(document);
  expect(encoded.chunks.length).toBeGreaterThan(10);
  encoded.chunks.forEach((text, index) => expect(() => parseMemoryViewChunk({ viewId: 'view', documentId: 'document', index, text })).not.toThrow());
  expect(new TextEncoder().encode(encoded.chunks.join('')).length).toBe(encoded.bytes);
  expect(decodeMemoryDocument(encoded.chunks.join(''), 'snapshot')).toEqual(document);
});

it('binds read-only navigation to the current view and sequence', () => {
  const value = parseMemoryViewRequest(request);
  expect(parseMemoryViewAction({ viewId: 'view', sequence: 1, action: 'chunk', index: 1 }, value)).toMatchObject({ index: 1 });
  for (const action of [{ viewId: 'other', sequence: 1, action: 'close' }, { viewId: 'view', sequence: 0, action: 'close' },
    { viewId: 'view', sequence: 1, action: 'chunk', index: 2 }, { viewId: 'view', sequence: 1, action: 'inspect', key: 'key' },
    { viewId: 'view', sequence: 1, action: 'run' }]) expect(() => parseMemoryViewAction(action, value)).toThrow();
});

it('rejects malformed catalogs, metadata, message structures and excessive nesting', () => {
  expect(() => decodeMemoryDocument(JSON.stringify({ kind: 'catalog', sessions: [session, session], current: [] }), 'catalog')).toThrow();
  expect(() => decodeMemoryDocument(JSON.stringify({ kind: 'catalog', sessions: [session], current: ['missing'] }), 'catalog')).toThrow();
  for (const change of [{ messages: [null] }, { metadata: { startedAt: 'now', status: 'unknown', phase: 'model' } }]) {
    expect(() => decodeMemoryDocument(JSON.stringify({ kind: 'snapshot', session, messages: [], diagnostics: [], ...change }), 'snapshot')).toThrow();
  }
  let deep: unknown = 'leaf'; for (let index = 0; index < 70; index++) deep = { child: deep };
  expect(() => decodeMemoryDocument(JSON.stringify({ kind: 'snapshot', session, messages: [{ role: 'user', content: 'hello', deep }], diagnostics: [] }), 'snapshot')).toThrow();
});
