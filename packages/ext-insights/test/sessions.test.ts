import { expect, it, vi } from 'vitest';
import {
  SESSION_HISTORY_LIMITS, type AgentRuntime, type ExtensionUi, type SessionsHistory, type UiDocument, type UiElementHandle, type UiPresentOptions,
} from '@felan-ai/agent-core';
import { createSessionsInsights } from '../src/sessions.js';
import { computeAnalytics } from '../src/analytics.js';
import { parseSessionTranscript } from '../src/parser.js';
import { INSIGHTS_DOCUMENT_HINT } from '../src/ui.js';

function fixture() {
  const lifetime = new AbortController();
  const info = { id: 'root', root: 'root', parent: 'old-root', title: 'Root', cwd: '/project', updatedAt: 1, state: 'open' as const };
  const entry = { type: 'message', id: 'entry', parentId: null, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'first' } };
  const sessions = {
    current: { id: 'root', root: 'root' },
    list: vi.fn<SessionsHistory['list']>().mockResolvedValue({ items: [info] }),
    checkpoint: vi.fn<SessionsHistory['checkpoint']>().mockResolvedValue({ sessionId: 'root', revision: 'journal-v1', branch: 'entry', byteLength: 1000, transcriptDigest: 'same-active-digest' }),
    history: vi.fn<SessionsHistory['history']>().mockResolvedValue({ sessionId: 'root', revision: 'journal-v1', branch: 'entry', entries: [entry] as never }),
  } satisfies SessionsHistory;
  const storage = { root: '/agent', mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) };
  const runtime = { storage: () => storage } as unknown as AgentRuntime;
  const documents: UiDocument[] = [];
  const update = vi.fn<UiElementHandle['update']>().mockImplementation(async document => { documents.push(document as UiDocument); });
  const close = vi.fn<UiElementHandle['close']>().mockResolvedValue(undefined);
  const ui = { present: vi.fn<ExtensionUi['present']>().mockImplementation(async document => {
    documents.push(document as UiDocument); return { update, close };
  }) };
  const host = createSessionsInsights(sessions, ui as unknown as ExtensionUi, lifetime.signal);
  return { lifetime, info, entry, sessions, storage, runtime, ui, host, documents, update, close };
}

it('pins full-journal versions and exact byte lengths, without treating a forked root as a child', async () => {
  const h = fixture();
  const [reference] = await h.host.listSessions(h.runtime);
  expect(reference).toMatchObject({ id: 'root', contentVersion: 'journal-v1', size: 1000 });
  expect(reference).not.toHaveProperty('isAgent');
  const text = await h.host.readSession(h.runtime, reference!);
  expect(text).toContain('first');
  expect(h.sessions).not.toHaveProperty('create');
  expect(h.sessions).not.toHaveProperty('steer');
  expect(h.sessions.history.mock.calls[0]![1]?.at).toEqual({ sessionId: 'root', revision: 'journal-v1', branch: 'entry' });
  await expect(h.host.readSession(h.runtime, { ...reference! })).rejects.toThrow('Insights');
  h.sessions.checkpoint.mockResolvedValue({ sessionId: 'root', revision: 'journal-v2', branch: 'entry', byteLength: 1000, transcriptDigest: 'same-active-digest' });
  expect((await h.host.listSessions(h.runtime))[0]!.contentVersion).toBe('journal-v2');
  await h.host.dispose();
});

it('preserves the original first-page session timestamp rather than a later message or page timestamp', async () => {
  const h = fixture();
  const [reference] = await h.host.listSessions(h.runtime);
  const startedAt = '2025-12-31T22:30:00.000Z';
  h.sessions.history.mockResolvedValueOnce({ sessionId: 'root', revision: 'journal-v1', branch: 'entry', startedAt, entries: [], nextCursor: 'next' })
    .mockResolvedValueOnce({ sessionId: 'root', revision: 'journal-v1', branch: 'entry', startedAt: '2026-01-01T01:00:00.000Z', entries: [h.entry] as never });
  const text = (await h.host.readSession(h.runtime, reference!))!;
  expect(JSON.parse(text.split('\n')[0]!)).toEqual({ type: 'session', id: 'root', cwd: '/project', timestamp: startedAt });
  expect(parseSessionTranscript(text, 'root')?.startTime.toISOString()).toBe(startedAt);
  expect(text.split('\n').filter(line => JSON.parse(line).type === 'session')).toHaveLength(1);
  await h.host.dispose();
});

it('rejects cross-session pages with otherwise identical revision and branch pins', async () => {
  const h = fixture();
  const [reference] = await h.host.listSessions(h.runtime);
  h.sessions.history.mockResolvedValueOnce({ sessionId: 'root', revision: 'journal-v1', branch: 'entry', entries: [], nextCursor: 'next' })
    .mockResolvedValueOnce({ sessionId: 'foreign', revision: 'journal-v1', branch: 'entry', entries: [h.entry] as never });
  await expect(h.host.readSession(h.runtime, reference!)).rejects.toThrow('Insights');
  expect(h.sessions.history).toHaveBeenCalledTimes(2);
  await h.host.dispose();
});

it('reads paginated entries once and rejects revision drift and duplicate entries', async () => {
  const h = fixture();
  const [reference] = await h.host.listSessions(h.runtime);
  h.sessions.history.mockImplementation(async (_id, options) => ({ sessionId: 'root', revision: 'journal-v1', branch: 'entry',
    entries: [options?.cursor ? { ...h.entry, id: 'second' } : h.entry] as never, ...(options?.cursor ? {} : { nextCursor: 'next' }),
  }));
  expect((await h.host.readSession(h.runtime, reference!))?.split('\n')).toHaveLength(3);
  h.sessions.history.mockResolvedValue({ sessionId: 'root', revision: 'wrong', branch: 'entry', entries: [] });
  await expect(h.host.readSession(h.runtime, reference!)).rejects.toThrow('Insights');
  h.sessions.history.mockResolvedValue({ sessionId: 'root', revision: 'journal-v1', branch: 'entry', entries: [h.entry, h.entry] as never });
  await expect(h.host.readSession(h.runtime, reference!)).rejects.toThrow('Insights');
  await h.host.dispose();
});

it('rejects bad catalogue pagination, diagnostics and oversized checkpoint metadata', async () => {
  const h = fixture();
  h.sessions.list.mockResolvedValue({ items: [], nextCursor: 'repeat' });
  await expect(h.host.listSessions(h.runtime)).rejects.toThrow('Insights');
  expect(h.sessions.list).toHaveBeenCalledTimes(2);
  h.sessions.list.mockResolvedValue({ items: [{ ...h.info, diagnostic: 'inaccessible' }] });
  await expect(h.host.listSessions(h.runtime)).rejects.toThrow('Insights');
  h.sessions.list.mockResolvedValue({ items: [h.info] });
  h.sessions.checkpoint.mockResolvedValue({ sessionId: 'root', revision: 'large', branch: null, byteLength: SESSION_HISTORY_LIMITS.fileBytes + 1, transcriptDigest: 'digest' });
  await expect(h.host.listSessions(h.runtime)).rejects.toThrow('Insights');
  await h.host.dispose();
});

it('waits for a cancelled provider read to settle and rejects subsequent use', async () => {
  const h = fixture();
  const [reference] = await h.host.listSessions(h.runtime);
  const entered = deferred<void>();
  const finish = deferred<Awaited<ReturnType<SessionsHistory['history']>>>();
  h.sessions.history.mockImplementationOnce(async () => { entered.resolve(); return finish.promise; });
  const reading = expect(h.host.readSession(h.runtime, reference!)).rejects.toMatchObject({ name: 'AbortError' });
  await entered.promise;
  let disposed = false;
  const disposal = h.host.dispose().then(() => { disposed = true; });
  expect(h.sessions.history.mock.calls.at(-1)![1]!.signal!.aborted).toBe(true);
  expect(disposed).toBe(false);
  finish.resolve({ sessionId: 'root', revision: 'journal-v1', branch: 'entry', entries: [] });
  await reading; await disposal;
  await expect(h.host.listSessions(h.runtime)).rejects.toMatchObject({ name: 'AbortError' });
});

it('makes a single-page report actionable and closes only on its declared cancel action', async () => {
  const h = fixture();
  await h.host.openReport!(h.runtime, '/report');
  const document = h.documents[0]!;
  expect(document.actions).toEqual([{ id: 'close', label: 'Close report', target: 'element', outcome: 'cancel' }]);
  const onAction = h.ui.present.mock.calls[0]![1]!.onAction!;
  const request = { elementId: document.id, revision: document.revision, actionId: 'close', outcome: 'cancel' as const, values: {} };
  const context = { requestId: 'close', signal: h.lifetime.signal };
  await expect(onAction({ ...request, outcome: 'submit' }, context)).rejects.toThrow();
  expect(h.close).not.toHaveBeenCalled();
  await onAction(request, context);
  expect(h.close).toHaveBeenCalledOnce();
  await expect(onAction(request, context)).rejects.toThrow();
  await h.host.dispose();
});

it('paginates complete escaped Unicode text and fences stale, foreign and retired-view actions', async () => {
  const h = fixture();
  const analytics = computeAnalytics([]);
  analytics.projectStats = [{ name: `${'界'.repeat(20_000)}<script>[x](file:///private)`, sessions: 1, messages: 1, tokens: 1, cost: 1, duration: 1 }];
  await h.host.enrichAnalytics!(analytics, h.runtime);
  await h.host.openReport!(h.runtime, '/report');
  const options = h.ui.present.mock.calls[0]![1]!;
  const invoke = (document: UiDocument, actionId: string, extra: object = {}, selected: UiPresentOptions = options) => selected.onAction!({
    elementId: document.id, revision: document.revision, actionId, outcome: 'submit', values: {}, ...extra,
  }, { requestId: 'action', signal: h.lifetime.signal });
  const old = h.documents.at(-1)!;
  expect(old.hint).toEqual(INSIGHTS_DOCUMENT_HINT);
  await expect(invoke(old, 'next', { elementId: 'foreign' })).rejects.toThrow();
  await expect(invoke(old, 'next', { values: { arbitrary: 'input' } })).rejects.toThrow();
  let text = old.markdown;
  while (h.documents.at(-1)!.actions.some(action => action.id === 'next')) {
    await invoke(h.documents.at(-1)!, 'next');
    const document = h.documents.at(-1)!;
    expect(new TextEncoder().encode(document.markdown).byteLength).toBeLessThanOrEqual(24_000);
    text += document.markdown;
  }
  expect(text.match(/界/gu)).toHaveLength(20_000);
  expect(text).not.toContain('<script>');
  await expect(invoke(old, 'next')).rejects.toThrow();
  await h.host.openReport!(h.runtime, '/new-report');
  await expect(invoke(h.documents.at(-1)!, 'next')).rejects.toThrow();
  await h.host.dispose();
  expect(h.close).toHaveBeenCalledTimes(2);
});

it('joins late presentation creation and reports handle cleanup failures', async () => {
  const h = fixture();
  const entered = deferred<void>();
  const finish = deferred<UiElementHandle>();
  h.ui.present.mockImplementationOnce(async () => { entered.resolve(); return finish.promise; });
  const opening = expect(h.host.openReport!(h.runtime, '/report')).rejects.toMatchObject({ name: 'AbortError' });
  await entered.promise;
  let disposed = false;
  const disposal = h.host.dispose().then(() => { disposed = true; });
  expect(disposed).toBe(false);
  finish.resolve({ update: h.update, close: h.close });
  await opening; await disposal;
  expect(h.close).toHaveBeenCalledOnce();
  const failure = fixture();
  await failure.host.openReport!(failure.runtime, '/report');
  failure.close.mockRejectedValueOnce(new Error('cleanup failed'));
  await expect(failure.host.dispose()).rejects.toThrow('cleanup failed');
});

it('uses runtime storage and refuses report path traversal', async () => {
  const h = fixture();
  expect(await h.host.writeReport(h.runtime, 'felan-insights.html', 'content')).toBe('/agent/insights-reports/felan-insights.html');
  await expect(h.host.writeReport(h.runtime, '../escape', 'content')).rejects.toThrow('Insights');
  expect(h.storage.writeFile).toHaveBeenCalledOnce();
  await h.host.dispose();
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
