import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_HISTORY_LIMITS, type SessionEntry } from '@felan-ai/agent-core';
import { createSessionHistoryBackend, type SessionHistorySource, type CreateSessionHistoryBackendOptions } from '../src/session-history.js';

const timestamp = '2026-08-24T10:00:00.000Z';
const privateKey = '/private/owned/transcript.jsonl';
const current = { id: 'root', root: 'root' };

function message(id: string, parentId: string | null, text = id): SessionEntry {
  return { type: 'message', id, parentId, timestamp, message: { role: 'user', content: text, timestamp: 0 } };
}

function source(id = 'root', overrides: Partial<SessionHistorySource> = {}): SessionHistorySource {
  return { key: id === 'root' ? privateKey : `/private/${id}.jsonl`, sessionId: id, id,
    root: id, cwd: '/project', title: id, updatedAt: 1, state: 'closed', ...overrides };
}

function transcript(id = 'root', entries: readonly unknown[] = [message('first', null)], version = 3): Uint8Array {
  return Buffer.from([JSON.stringify({ type: 'session', version, id, cwd: '/project', timestamp }),
    ...entries.map(entry => JSON.stringify(entry))].join('\n'));
}

function fixture(rows: SessionHistorySource[] = [source()], entries: readonly unknown[] = [message('first', null)]) {
  const files = new Map(rows.map(row => [row.key, transcript(row.sessionId, entries)]));
  const inventory = vi.fn<CreateSessionHistoryBackendOptions['inventory']>(async () => rows);
  const read = vi.fn<CreateSessionHistoryBackendOptions['read']>(async row => {
    const value = files.get(row.key);
    if (!value) throw new Error(`Private file unavailable: ${row.key}`);
    return value;
  });
  const backend = createSessionHistoryBackend({ current, project: '/project', inventory, read });
  return { backend, files, rows, inventory, read };
}

describe('read-only session history', () => {
  it('constructs without I/O and exposes only scoped history operations', () => {
    const f = fixture();
    expect(Object.keys(f.backend).sort()).toEqual(['checkpoint', 'current', 'history', 'list']);
    expect(f.backend.current).toEqual(current);
    expect(Object.isFrozen(f.backend.current)).toBe(true);
    expect(Object.isFrozen(f.backend)).toBe(true);
    expect(f.inventory).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });

  it('applies root and exact-project filters within the injected visible inventory', async () => {
    const f = fixture([source(), source('child', { root: 'root', parent: 'root', cwd: '/other' }),
      source('peer'), source('foreign', { cwd: '/different' })]);
    expect((await f.backend.list({ scope: 'root' })).items.map(row => row.id)).toEqual(['child', 'root']);
    expect((await f.backend.list({ scope: 'project' })).items.map(row => row.id)).toEqual(['peer', 'root']);
    expect((await f.backend.list({ scope: 'visible' })).items).toHaveLength(4);
    expect(f.read).not.toHaveBeenCalled();
    await expect(f.backend.history('unlisted')).rejects.toMatchObject({ code: 'inaccessible' });
    expect(f.read).not.toHaveBeenCalled();
  });

  it('reuses canonical IDs and gives duplicate legacy header IDs distinct stable opaque handles', async () => {
    const legacy: SessionHistorySource = { key: '/private/old-a.jsonl', sessionId: 'legacy', cwd: '/project', title: 'legacy', updatedAt: 1, state: 'closed' };
    const f = fixture([source(), legacy, { ...legacy, key: '/private/old-b.jsonl' }]);
    const first = await f.backend.list({ scope: 'visible' }, { limit: 1 });
    const second = await f.backend.list({ scope: 'visible' }, { limit: 1, cursor: first.nextCursor! });
    expect(first.items[0]!.id).toMatch(/^history-[a-f0-9]{64}$/u);
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    expect(await f.backend.list({ scope: 'visible' }, { limit: 1 })).toEqual(first);
    expect(JSON.stringify(first)).not.toContain('/private/');
    expect((await f.backend.history(first.items[0]!.id)).entries).toEqual([message('first', null)]);
    expect(f.read.mock.calls[0]![0].key).toMatch(/^\/private\/old-/u);
  });

  it('resolves a canonical ID through its private original Pi header identity', async () => {
    const f = fixture([source('pi-original', { id: 'canonical', root: 'root', parent: 'root' })]);
    expect((await f.backend.list({ scope: 'root' })).items[0]).toMatchObject({ id: 'canonical', root: 'root', parent: 'root' });
    expect((await f.backend.history('canonical')).entries).toEqual([message('first', null)]);
    await expect(f.backend.history('pi-original')).rejects.toMatchObject({ code: 'inaccessible' });
  });

  it('rejects path addressing and caller-crafted cursors without reading any file', async () => {
    const f = fixture();
    await expect(f.backend.history(privateKey)).rejects.toMatchObject({ code: 'invalid' });
    await expect(f.backend.list({ scope: 'visible' }, { cursor: '../escape' })).rejects.toMatchObject({ code: 'invalid' });
    expect(f.read).not.toHaveBeenCalled();
  });

  it('returns complete raw entries, not a projected or compacted message-only history', async () => {
    const entries: SessionEntry[] = [message('one', null),
      { type: 'custom', id: 'two', parentId: 'one', timestamp, customType: 'example', data: { retained: true } },
      { type: 'compaction', id: 'three', parentId: 'two', timestamp, firstKeptEntryId: 'one', tokensBefore: 12, summary: 'summary', details: { retained: true } },
      { type: 'context_edit', id: 'four', parentId: 'three', timestamp, targetId: 'one', replacement: { content: 'changed' } },
      { type: 'custom_message', id: 'five', parentId: 'four', timestamp, customType: 'felan-memory-context', content: 'context', display: false }];
    const f = fixture(undefined, entries);
    const all: SessionEntry[] = [];
    let cursor: string | undefined;
    do {
      const page = await f.backend.history('root', { limit: 2, ...(cursor ? { cursor } : {}) });
      all.push(...page.entries);
      cursor = page.nextCursor;
    } while (cursor);
    expect(all).toEqual(entries);
    expect(f.files.get(privateKey)).toEqual(transcript('root', entries));
    expect(f.read).toHaveBeenCalledTimes(3);
    all[0]!.timestamp = 'caller mutation';
    expect((await f.backend.history('root')).entries[0]!.timestamp).toBe(timestamp);
  });

  it('pins both full content and the active tip across history pages', async () => {
    const entries = [message('one', null), message('two', 'one')];
    const f = fixture(undefined, entries);
    const first = await f.backend.history('root', { limit: 1 });
    const at = { sessionId: first.sessionId, revision: first.revision, branch: first.branch };
    expect(first.revision).toBe(hash(f.files.get(privateKey)!));
    await expect(f.backend.history('root', { at })).resolves.toMatchObject(at);
    f.files.set(privateKey, transcript('root', [message('one', null, 'different'), message('two', 'one')]));
    await expect(f.backend.history('root', { cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'stale' });
    await expect(f.backend.history('root', { at })).rejects.toMatchObject({ code: 'stale' });
  });

  it('treats the last transcript entry as the active leaf even when it branches from an earlier entry', async () => {
    const entries = [message('one', null), message('left', 'one'), message('right', 'one')];
    const f = fixture(undefined, entries);
    const history = await f.backend.history('root');
    expect(history.entries).toEqual(entries);
    expect(history.branch).toBe('right');
    const checkpoint = await f.backend.checkpoint('root');
    expect(checkpoint).toMatchObject({ sessionId: 'root', branch: 'right', byteLength: f.files.get(privateKey)!.byteLength });
    expect(checkpoint).not.toHaveProperty('leafId');
    expect(checkpoint.transcriptDigest).toBe(hash(canonical([entries[0]!, entries[2]!])));
  });

  it('never reports stale for entries appended after a branch, wherever they attach', async () => {
    const entries = [message('one', null), message('left', 'one'), message('right', 'one'), message('later', 'left')];
    const f = fixture(undefined, entries);
    expect((await f.backend.history('root')).branch).toBe('later');
    f.files.set(privateKey, transcript('root', [...entries.slice(0, -1), message('later', 'right')]));
    expect((await f.backend.history('root')).branch).toBe('later');
    expect((await f.backend.checkpoint('root')).branch).toBe('later');
  });

  it('uses a feature-neutral canonical branch digest including custom context and usage', async () => {
    const entries: SessionEntry[] = [message('one', null),
      { type: 'custom_message', id: 'context', parentId: 'one', timestamp, customType: 'felan-memory-context', content: 'evidence', display: false }];
    const f = fixture(undefined, entries);
    const first = await f.backend.checkpoint('root');
    const reordered = entries.map(entry => Object.fromEntries(Object.entries(entry).reverse()));
    f.files.set(privateKey, transcript('root', reordered));
    const second = await f.backend.checkpoint('root');
    expect(second.revision).not.toBe(first.revision);
    expect(second.transcriptDigest).toBe(first.transcriptDigest);
    expect(second.transcriptDigest).toBe(hash(canonical(entries)));
    expect(second.transcriptDigest).not.toBe(hash(canonical([entries[0]])));
  });

  it('treats empty transcripts with a valid header as an empty branch', async () => {
    const f = fixture(undefined, []);
    expect(await f.backend.history('root')).toMatchObject({ entries: [], branch: null });
    expect((await f.backend.history('root')).startedAt).toBe(timestamp);
    expect(await f.backend.checkpoint('root')).toMatchObject({ branch: null, transcriptDigest: hash('[]') });
  });

  it('never fabricates creation timestamps from inventory modification time', async () => {
    const f = fixture([source('root', { updatedAt: Date.now() })]);
    f.files.set(privateKey, Buffer.from(JSON.stringify({ type: 'session', id: 'root', cwd: '/project', version: 3 })));
    expect(await f.backend.history('root')).not.toHaveProperty('startedAt');
    f.files.set(privateKey, Buffer.from(JSON.stringify({ type: 'session', id: 'root', cwd: '/project', version: 3, timestamp: 'invalid' })));
    expect(await f.backend.history('root')).not.toHaveProperty('startedAt');
  });

  it('rejects list pagination after inventory changes and cursors from another scope or backend', async () => {
    const f = fixture([source(), source('other')]);
    const page = await f.backend.list({ scope: 'visible' }, { limit: 1 });
    await expect(f.backend.list({ scope: 'root' }, { cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'stale' });
    const foreign = fixture([source(), source('other')]);
    await expect(foreign.backend.list({ scope: 'visible' }, { cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'invalid' });
    f.rows[0] = source('root', { title: 'new title' });
    await expect(f.backend.list({ scope: 'visible' }, { cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'stale' });
  });

  it('rejects a valid history cursor when applied to another visible session', async () => {
    const f = fixture([source(), source('other')], [message('one', null), message('two', 'one')]);
    const page = await f.backend.history('root', { limit: 1 });
    await expect(f.backend.history('other', { cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'stale' });
  });

  it('detects visibility or source identity changes during the injected read', async () => {
    const f = fixture();
    f.read.mockImplementationOnce(async () => { f.rows.splice(0); return transcript(); });
    await expect(f.backend.history('root')).rejects.toMatchObject({ code: 'stale' });
    const replacement = fixture();
    replacement.read.mockImplementationOnce(async () => {
      replacement.rows[0] = source('root', { key: '/private/replacement.jsonl' });
      return transcript();
    });
    await expect(replacement.backend.history('root')).rejects.toMatchObject({ code: 'stale' });
  });

  it('retains explicit inventory diagnostics without returning empty successful history', async () => {
    for (const diagnostic of ['inaccessible', 'oversize', 'unsupported'] as const) {
      const f = fixture([source('root', { diagnostic })]);
      expect((await f.backend.list({ scope: 'visible' })).items[0]!.diagnostic).toBe(diagnostic);
      await expect(f.backend.history('root')).rejects.toMatchObject({ code: diagnostic });
      expect(f.read).not.toHaveBeenCalled();
    }
  });

  it('enforces the file bound before dispatch and after injected I/O', async () => {
    const f = fixture([source('root', { bytes: SESSION_HISTORY_LIMITS.fileBytes + 1 })]);
    await expect(f.backend.history('root')).rejects.toMatchObject({ code: 'oversize' });
    expect(f.read).not.toHaveBeenCalled();
    const actual = fixture();
    actual.read.mockResolvedValueOnce(new Uint8Array(SESSION_HISTORY_LIMITS.fileBytes + 1));
    await expect(actual.backend.history('root')).rejects.toMatchObject({ code: 'oversize' });
  });

  it('checks supplied content fingerprints and byte counts', async () => {
    const f = fixture([source('root', { fingerprint: '0'.repeat(64) })]);
    await expect(f.backend.history('root')).rejects.toMatchObject({ code: 'stale' });
    f.rows[0] = source('root', { bytes: 1 });
    await expect(f.backend.history('root')).rejects.toMatchObject({ code: 'stale' });
  });

  it('rejects non-finite JSON numbers and oversized headers without losing validation errors', async () => {
    const f = fixture();
    f.files.set(privateKey, Buffer.from(`${JSON.stringify({ type: 'session', version: 3, id: 'root', cwd: '/project' })}\n`
      + `{"type":"custom","id":"one","parentId":null,"timestamp":"${timestamp}","customType":"example","data":1e999}`));
    await expect(f.backend.history('root')).rejects.toMatchObject({ code: 'invalid' });
    f.files.set(privateKey, Buffer.from(JSON.stringify({ type: 'session', version: 3, id: 'root', cwd: 'x'.repeat(65_537) })));
    await expect(f.backend.history('root')).rejects.toMatchObject({ code: 'oversize' });
  });

  it('limits count and encoded bytes without dropping or truncating full entries', async () => {
    const many = Array.from({ length: 257 }, (_, index) => message(`entry-${index}`, index ? `entry-${index - 1}` : null));
    const f = fixture(undefined, many);
    const first = await f.backend.history('root');
    expect(first.entries).toHaveLength(256);
    expect((await f.backend.history('root', { cursor: first.nextCursor! })).entries).toEqual([many[256]]);
    const text = 'x'.repeat(6 * 1024 * 1024);
    f.files.set(privateKey, transcript('root', [message('one', null, text), message('two', 'one', text)]));
    const big = await f.backend.history('root');
    expect(big.entries).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(big))).toBeLessThanOrEqual(SESSION_HISTORY_LIMITS.pageBytes);
    expect((await f.backend.history('root', { cursor: big.nextCursor! })).entries).toEqual([message('two', 'one', text)]);
    f.files.set(privateKey, transcript('root', [message('oversized', null, 'x'.repeat(SESSION_HISTORY_LIMITS.pageBytes))]));
    await expect(f.backend.history('root')).rejects.toMatchObject({ code: 'oversize' });
  });

  it.each([0, -1, 257, 1.5, Number.NaN])('rejects invalid page limits %s before I/O', async limit => {
    const f = fixture();
    await expect(f.backend.history('root', { limit })).rejects.toMatchObject({ code: 'invalid' });
    expect(f.inventory).not.toHaveBeenCalled();
  });

  it('rejects malformed UTF-8, JSON, entry graphs and mismatched headers without echoing source text', async () => {
    const bad = [new Uint8Array([0xff]), Buffer.from('private-secret-invalid-json'), Buffer.from('null'),
      transcript('wrong'), transcript('root', [message('one', 'missing')]),
      transcript('root', [message('root', null)]),
      transcript('root', [message('same', null), message('same', 'same')]),
      transcript('root', [{ type: 'message', id: 'one', parentId: null, timestamp }])];
    for (const bytes of bad) {
      const f = fixture();
      f.files.set(privateKey, bytes);
      const error = await failure(f.backend.history('root'));
      expect(error).toMatchObject({ code: 'invalid' });
      expect(error).not.toHaveProperty('cause');
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain('private');
    }
  });

  it('explicitly rejects v1 or unknown formats and migrates v2 in memory with stable IDs', async () => {
    const f = fixture();
    for (const version of [1, 4]) {
      f.files.set(privateKey, transcript('root', [message('first', null)], version));
      await expect(f.backend.history('root')).rejects.toMatchObject({ code: 'unsupported' });
    }
    const v2 = transcript('root', [
      { type: 'message', id: 'one', parentId: null, timestamp, message: { role: 'hookMessage', content: 'old' } },
      message('two', 'one'),
    ], 2);
    f.files.set(privateKey, v2);
    const first = await f.backend.history('root', { limit: 1 });
    expect(first.entries[0]).toMatchObject({ id: 'one', message: { role: 'custom' } });
    expect((await f.backend.history('root', { cursor: first.nextCursor! })).entries[0]!.id).toBe('two');
    expect(await f.backend.history('root', { limit: 1 })).toEqual(first);
    expect(f.files.get(privateKey)).toEqual(v2);
  });

  it('propagates cancellation, never dispatches after preflight abort, and waits for injected reads to settle', async () => {
    const f = fixture();
    const aborted = AbortSignal.abort(new Error('private-abort-reason'));
    await expect(f.backend.history('root', { signal: aborted })).rejects.toMatchObject({ name: 'AbortError', message: 'Session history request aborted.' });
    expect(f.inventory).not.toHaveBeenCalled();
    let release!: (value: Uint8Array) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.read.mockImplementationOnce(async (_source, options) => {
      expect(options.maxBytes).toBe(SESSION_HISTORY_LIMITS.fileBytes);
      entered();
      return new Promise<Uint8Array>(resolve => { release = resolve; });
    });
    const controller = new AbortController();
    let settled = false;
    const work = failure(f.backend.history('root', { signal: controller.signal })).then(error => { settled = true; return error; });
    await started;
    expect(f.read.mock.calls[0]![1].signal).toBe(controller.signal);
    controller.abort(new Error('private-abort-reason'));
    expect(settled).toBe(false);
    release(transcript());
    const error = await work;
    expect(error).toMatchObject({ name: 'AbortError', message: 'Session history request aborted.' });
    expect(error).not.toHaveProperty('cause');
  });

  it('sanitizes injected failures and rejects duplicate canonical identities', async () => {
    const f = fixture();
    f.read.mockRejectedValueOnce(new Error(`secret in ${privateKey}`));
    const error = await failure(f.backend.history('root'));
    expect(error).toMatchObject({ code: 'inaccessible' });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain(privateKey);
    expect(error).not.toHaveProperty('cause');
    f.rows.push(source('other', { id: 'root' }));
    await expect(f.backend.list({ scope: 'visible' })).rejects.toMatchObject({ code: 'inaccessible' });
  });
});

function hash(value: Uint8Array | string): string { return createHash('sha256').update(value).digest('hex'); }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) as string;
}

async function failure(work: Promise<unknown>): Promise<unknown> {
  try { await work; } catch (error) { return error; }
  throw new Error('Expected failure');
}
