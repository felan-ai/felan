import { describe, expect, it, vi } from 'vitest';
import type { SessionsHistory } from '@felan-ai/agent-core';
import { readMemorySessionCheckpoint } from '../src/session-history.js';
import {
  MEMORY_CONTEXT_CUSTOM_TYPE,
  digestActiveBranch,
  materializeMemoryInputDelta,
  materializeMemorySessionCheckpoint,
  removeMemoryContextEntries,
  type SessionCheckpoint,
} from '../src/index.js';

const entries = [
  { type: 'message', id: 'user', parentId: null, message: { role: 'user', content: 'Remember the release preference.' } },
  { type: 'custom_message', id: 'memory', parentId: 'user', customType: MEMORY_CONTEXT_CUSTOM_TYPE, content: 'Existing memory must not teach itself.' },
  { type: 'message', id: 'old-leaf', parentId: 'memory', message: { role: 'assistant', content: 'Noted.' } },
  { type: 'custom', id: 'custom', parentId: 'user', customType: 'audit', data: { preserve: true } },
  { type: 'compaction', id: 'compacted', parentId: 'custom', firstKeptEntryId: 'user', summary: 'A later branch.' },
  { type: 'message', id: 'new-leaf', parentId: 'compacted', message: { role: 'user', content: 'The correction is authoritative.' } },
];
const old: SessionCheckpoint = {
  sessionId: 'session-1', sessionFile: '/legacy/original.jsonl', leafId: 'old-leaf',
  transcriptDigest: digestActiveBranch(removeMemoryContextEntries(entries.slice(0, 3))),
};
const current: SessionCheckpoint = {
  ...old, leafId: 'new-leaf', transcriptDigest: digestActiveBranch([entries[0], ...entries.slice(3)]),
};

describe('shared Sessions memory history materialization', () => {
  it('preserves legacy checkpoints and produces identical evidence from full paginated history', async () => {
    const sessions = fixture();
    const checkpoint = structuredClone(current);
    const previousCheckpoint = structuredClone(old);
    const result = await materializeMemorySessionCheckpoint({ sessions, checkpoint, previousCheckpoint });
    const legacy = await materializeMemoryInputDelta({
      checkpoint, previousCheckpoint,
      lines: async function* () {
        yield JSON.stringify({ type: 'session', id: 'session-1' });
        for (const entry of entries) yield JSON.stringify(entry);
      },
    });
    expect(result).toEqual(legacy);
    expect(result).toMatchObject({ ok: true, projection: { relation: 'diverged', previousCheckpoint: old } });
    expect(checkpoint).toEqual(current);
    expect(previousCheckpoint).toEqual(old);
    expect(sessions.checkpoint).toHaveBeenCalledOnce();
    expect(sessions.history).toHaveBeenCalledTimes(4);
    for (const call of sessions.history.mock.calls) expect(call[1]?.at).toEqual({ sessionId: 'session-1', revision: 'revision-7', branch: 'new-leaf' });
    if (result.ok) {
      expect(result.text).toContain('firstKeptEntryId');
      expect(result.text).toContain('The correction is authoritative.');
      expect(result.text).not.toContain('Existing memory must not teach itself.');
    }
  });

  it('verifies a retained checkpoint on an abandoned branch instead of replacing it with the current leaf', async () => {
    const result = await materializeMemorySessionCheckpoint({ sessions: fixture(), checkpoint: old });
    expect(result).toMatchObject({ ok: true, projection: { relation: 'initial' } });
    if (result.ok) {
      expect(result.text).toContain('Noted.');
      expect(result.text).not.toContain('The correction is authoritative.');
    }
  });

  it('blocks incomplete active-branch-only history rather than silently dropping the previous lineage', async () => {
    const sessions = fixture();
    sessions.history.mockImplementation(async () => ({
      sessionId: 'session-1', revision: 'revision-7', branch: 'new-leaf', entries: [entries[0], ...entries.slice(3)] as never,
    }));
    const result = await materializeMemorySessionCheckpoint({ sessions, checkpoint: current, previousCheckpoint: old });
    expect(result).toMatchObject({ ok: false, code: 'invalid_source' });
    expect(old.sessionFile).toBe('/legacy/original.jsonl');
  });

  it('rejects matching IDs whose retained content no longer matches the recorded digest', async () => {
    const sessions = fixture();
    sessions.history.mockImplementation(async () => ({
      sessionId: 'session-1', revision: 'revision-7', branch: 'new-leaf', entries: entries.map(entry => entry.id === 'old-leaf'
        ? { ...entry, message: { role: 'assistant', content: 'Changed old evidence.' } } : entry) as never,
    }));
    expect(await materializeMemorySessionCheckpoint({ sessions, checkpoint: current, previousCheckpoint: old }))
      .toMatchObject({ ok: false, code: 'previous_checkpoint_changed' });
  });

  it('does not treat a missing canonical journal as an empty historical session', async () => {
    const sessions = fixture();
    sessions.history.mockResolvedValue({ sessionId: 'session-1', revision: 'revision-7', branch: 'new-leaf', entries: [] });
    const result = await materializeMemorySessionCheckpoint({
      sessions, checkpoint: { ...old, leafId: null, transcriptDigest: digestActiveBranch([]) },
    });
    expect(result).toMatchObject({ ok: false, code: 'source_unavailable' });
  });

  it('accepts a verified empty journal with a null canonical branch', async () => {
    const sessions = fixture();
    const empty = { ...old, leafId: null, transcriptDigest: digestActiveBranch([]) };
    sessions.checkpoint.mockResolvedValue({ ...empty, revision: 'empty-revision', branch: null, byteLength: 0 });
    sessions.history.mockResolvedValue({ sessionId: 'session-1', revision: 'empty-revision', branch: null, entries: [] });
    const result = await materializeMemorySessionCheckpoint({ sessions, checkpoint: empty });
    expect(result).toMatchObject({ ok: true, text: '', projection: { includedEntryCount: 0 } });
  });

  it('rejects revision drift and sanitizes backend diagnostics', async () => {
    const sessions = fixture();
    sessions.history.mockResolvedValueOnce({ sessionId: 'session-1', revision: 'revision-8', branch: 'new-leaf', entries: [] });
    expect(await materializeMemorySessionCheckpoint({ sessions, checkpoint: current }))
      .toMatchObject({ ok: false, code: 'source_unavailable' });
    sessions.checkpoint.mockRejectedValueOnce(new Error('private history path and credential'));
    const result = await materializeMemorySessionCheckpoint({ sessions, checkpoint: current });
    expect(result).toMatchObject({ ok: false, code: 'source_unavailable' });
    expect(JSON.stringify(result)).not.toContain('private history');
  });

  it('rejects mismatched session identity, repeating cursors and changed replay content', async () => {
    const mismatched = fixture();
    mismatched.checkpoint.mockResolvedValueOnce({ ...current, sessionId: 'foreign', revision: 'revision-7', branch: 'new-leaf', byteLength: 4096 });
    expect(await materializeMemorySessionCheckpoint({ sessions: mismatched, checkpoint: current }))
      .toMatchObject({ ok: false, code: 'source_unavailable' });
    expect(mismatched.history).not.toHaveBeenCalled();

    const repeating = fixture();
    repeating.history.mockResolvedValue({ sessionId: 'session-1', revision: 'revision-7', branch: 'new-leaf', entries: [], nextCursor: 'repeat' });
    expect(await materializeMemorySessionCheckpoint({ sessions: repeating, checkpoint: current }))
      .toMatchObject({ ok: false, code: 'source_unavailable' });

    const changed = fixture();
    changed.history.mockImplementation(async (_id, options) => ({
      sessionId: 'session-1', revision: 'revision-7', branch: 'new-leaf',
      entries: (changed.history.mock.calls.length > 2
        ? entries.map(entry => entry.id === 'new-leaf' ? { ...entry, message: { role: 'user', content: 'Changed during replay.' } } : entry)
        : entries).slice(options?.cursor ? 3 : 0, options?.cursor ? undefined : 3) as never,
      ...(options?.cursor ? {} : { nextCursor: 'next' }),
    }));
    expect(await materializeMemorySessionCheckpoint({ sessions: changed, checkpoint: current }))
      .toMatchObject({ ok: false, code: 'source_changed' });
  });

  it('retains whole records on output-limit failures and supports cancellation', async () => {
    expect(await materializeMemorySessionCheckpoint({ sessions: fixture(), checkpoint: current, maxOutputBytes: 1 }))
      .toMatchObject({ ok: false, code: 'output_too_large' });
    const sessions = fixture();
    const controller = new AbortController();
    controller.abort(new Error('private cancellation reason'));
    const result = await materializeMemorySessionCheckpoint({ sessions, checkpoint: current, signal: controller.signal });
    expect(result).toMatchObject({ ok: false, code: 'cancelled' });
    expect(sessions.checkpoint).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private cancellation');
  });

  it('rejects a page from another session despite matching revision and branch', async () => {
    const sessions = fixture();
    sessions.history.mockResolvedValueOnce({ sessionId: 'foreign', revision: 'revision-7', branch: 'new-leaf', entries: entries as never });
    expect(await materializeMemorySessionCheckpoint({ sessions, checkpoint: current }))
      .toMatchObject({ ok: false, code: 'source_unavailable' });
    expect(sessions).not.toHaveProperty('create');
    expect(sessions).not.toHaveProperty('steer');
  });
});

function fixture() {
  const checkpoint = vi.fn<SessionsHistory['checkpoint']>().mockResolvedValue({
    sessionId: 'session-1', transcriptDigest: current.transcriptDigest, revision: 'revision-7', branch: 'new-leaf', byteLength: 4096,
  });
  const history = vi.fn<SessionsHistory['history']>().mockImplementation(async (_id, options) => ({
    sessionId: 'session-1', revision: 'revision-7', branch: 'new-leaf',
    entries: entries.slice(options?.cursor ? 3 : 0, options?.cursor ? undefined : 3) as never,
    ...(options?.cursor ? {} : { nextCursor: 'next' }),
  }));
  return { checkpoint, history } satisfies Pick<SessionsHistory, 'checkpoint' | 'history'>;
}

describe('startup recovery checkpoints', () => {
  it('records the same checkpoint a live session records, from paginated history', async () => {
    const sessions = fixture();
    await expect(readMemorySessionCheckpoint(sessions, 'session-1')).resolves.toEqual({
      sessionId: 'session-1', sessionFile: 'session-1', leafId: 'new-leaf', transcriptDigest: current.transcriptDigest,
    });
    expect(sessions.history).toHaveBeenCalledTimes(2);
  });

  it('excludes memory-context entries from the active branch digest exactly as live checkpoints do', async () => {
    const sessions = fixture();
    sessions.history.mockImplementation(async (_id, options) => ({
      sessionId: 'session-1', revision: 'revision-7', branch: 'old-leaf',
      entries: entries.slice(options?.cursor ? 3 : 0, options?.cursor ? undefined : 3) as never,
      ...(options?.cursor ? {} : { nextCursor: 'next' }),
    }));
    await expect(readMemorySessionCheckpoint(sessions, 'session-1')).resolves.toMatchObject({
      leafId: 'old-leaf', transcriptDigest: old.transcriptDigest,
    });
  });

  it('fails instead of mixing pages when the history revision changes between pages', async () => {
    const sessions = fixture();
    sessions.history.mockImplementation(async (_id, options) => ({
      sessionId: 'session-1', revision: options?.cursor ? 'revision-8' : 'revision-7', branch: 'new-leaf',
      entries: entries.slice(options?.cursor ? 3 : 0, options?.cursor ? undefined : 3) as never,
      ...(options?.cursor ? {} : { nextCursor: 'next' }),
    }));
    await expect(readMemorySessionCheckpoint(sessions, 'session-1')).rejects.toThrow('revision changed');
  });
});
