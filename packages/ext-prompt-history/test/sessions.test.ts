import { expect, it, vi } from 'vitest';
import { SESSION_HISTORY_LIMITS, type SessionsHistory } from '@felan-ai/agent-core';
import { createSessionsPromptHistory } from '../src/sessions.js';
import { searchPromptHistory } from '../src/history.js';

function fixture() {
  const controller = new AbortController();
  const info = { id: 'session', root: 'session', title: 'Saved', cwd: '/project', updatedAt: 1, state: 'open' as const };
  const first = { type: 'message', id: 'one', parentId: null, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'first' } };
  const second = { ...first, id: 'two', parentId: 'one', message: { role: 'user', content: 'second' } };
  const sessions = {
    current: { id: info.id, root: info.id },
    list: vi.fn<SessionsHistory['list']>().mockResolvedValue({ items: [info] }),
    checkpoint: vi.fn<SessionsHistory['checkpoint']>().mockResolvedValue({
      sessionId: info.id, revision: 'whole-journal-v1', branch: 'two', transcriptDigest: 'active-branch', byteLength: 1000,
    }),
    history: vi.fn<SessionsHistory['history']>().mockImplementation(async (_id, options) => ({
      sessionId: 'session', revision: 'whole-journal-v1', branch: 'two', entries: [options?.cursor ? second : first] as never,
      ...(options?.cursor ? {} : { nextCursor: 'next' }),
    })),
  } satisfies SessionsHistory;
  const host = createSessionsPromptHistory(sessions, controller.signal);
  return { controller, info, sessions, host, first, second };
}

it('reads issued references through bounded, pinned pages without paths or history mutation', async () => {
  const h = fixture();
  const [reference] = await h.host.listSessions('/ignored-client-path');
  expect(await h.host.readSession(reference!)).toMatchObject({ cwd: '/project', name: 'Saved', entries: [h.first, h.second] });
  expect(h.sessions.list).toHaveBeenCalledWith({ scope: 'visible' }, { signal: h.controller.signal, limit: 256 });
  for (const call of h.sessions.history.mock.calls) expect(call[1]).toMatchObject({ at: { sessionId: 'session', revision: 'whole-journal-v1', branch: 'two' }, signal: h.controller.signal });
  await expect(h.host.readSession({ ...reference! })).rejects.toThrow('unavailable');
  expect(h.sessions.checkpoint).toHaveBeenCalledTimes(1);
  expect(h.sessions).not.toHaveProperty('create');
  expect(h.sessions).not.toHaveProperty('steer');
});

it('rejects a page from another session even when revision and branch match', async () => {
  const h = fixture();
  const [reference] = await h.host.listSessions('/ignored');
  h.sessions.history.mockResolvedValueOnce({ sessionId: 'session', revision: 'whole-journal-v1', branch: 'two', entries: [h.first] as never, nextCursor: 'next' })
    .mockResolvedValueOnce({ sessionId: 'foreign', revision: 'whole-journal-v1', branch: 'two', entries: [h.second] as never });
  await expect(h.host.readSession(reference!)).rejects.toThrow('unavailable');
  expect(h.sessions.history).toHaveBeenCalledTimes(2);
});

it('rejects duplicate catalogue IDs, diagnostic entries and non-advancing pagination', async () => {
  for (const result of [
    { items: [fixture().info, fixture().info] },
    { items: [{ ...fixture().info, diagnostic: 'inaccessible' as const }] },
    { items: [], nextCursor: '' },
    { items: [], nextCursor: 'repeat' },
  ]) {
    const h = fixture();
    h.sessions.list.mockResolvedValue(result);
    await expect(h.host.listSessions('/ignored')).rejects.toThrow('unavailable');
    expect(h.sessions.list.mock.calls.length).toBeLessThanOrEqual(2);
  }
});

it('rejects revision drift, duplicate entries and checkpoint overflow before returning partial history', async () => {
  const h = fixture();
  const [reference] = await h.host.listSessions('/ignored');
  h.sessions.history.mockResolvedValueOnce({ sessionId: 'session', revision: 'changed', branch: 'two', entries: [] });
  await expect(h.host.readSession(reference!)).rejects.toThrow('unavailable');
  h.sessions.history.mockResolvedValue({ sessionId: 'session', revision: 'whole-journal-v1', branch: 'two', entries: [h.first, h.first] as never });
  await expect(h.host.readSession(reference!)).rejects.toThrow('unavailable');
  h.sessions.history.mockClear();
  h.sessions.checkpoint.mockResolvedValue({ sessionId: 'session', revision: 'large', branch: null, transcriptDigest: 'digest', byteLength: SESSION_HISTORY_LIMITS.fileBytes + 1 });
  await expect(h.host.readSession(reference!)).rejects.toThrow('unavailable');
  expect(h.sessions.history).not.toHaveBeenCalled();
});

it('propagates cancellation and sanitizes backend failures', async () => {
  const h = fixture();
  const [reference] = await h.host.listSessions('/ignored');
  h.sessions.history.mockRejectedValueOnce(new Error('private session credentials'));
  await expect(h.host.readSession(reference!)).rejects.toThrow('Prompt history is unavailable.');
  h.controller.abort(new Error('private reason'));
  await expect(h.host.readSession(reference!)).rejects.toMatchObject({ name: 'AbortError', message: 'Prompt history cancelled.' });
  expect(h.sessions.history).toHaveBeenCalledOnce();
});

it('reports catalogue or individual read failures as incomplete searches, not empty complete success', async () => {
  const progress = vi.fn();
  const source = { cwd: '/project', sessionDirectory: '/ignored', getCurrentItems: () => [], host: {
    listSessions: vi.fn(async () => { throw new Error('unavailable'); }), readSession: vi.fn(async () => undefined),
  } };
  expect(await searchPromptHistory(source, 'all', '', progress, () => true)).toMatchObject({ complete: false, scanned: 0 });
  source.host.listSessions.mockImplementation(async () => [{ id: 'one', label: 'one', timestamp: 1 }] as never);
  source.host.readSession.mockRejectedValueOnce(new Error('unavailable'));
  expect(await searchPromptHistory(source, 'all', '', progress, () => true)).toMatchObject({ complete: false, scanned: 1 });
});
