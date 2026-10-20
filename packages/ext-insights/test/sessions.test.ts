import { expect, it, vi } from 'vitest';
import {
  SESSION_HISTORY_LIMITS, SessionsServiceError, type AgentRuntime, type ExtensionUi, type SessionsHistory, type UiDocument, type UiElementHandle, type UiPresentOptions,
} from '@felan-ai/agent-core';
import { createSessionsInsights } from '../src/sessions.js';
import type { InsightsReport } from '../src/contracts.js';
import { parseSessionTranscript } from '../src/parser.js';
import { INSIGHTS_DOCUMENT_HINT, readInsightsDashboard } from '../src/data.js';

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
  const ui = {
    present: vi.fn<ExtensionUi['present']>().mockImplementation(async document => {
      documents.push(document as UiDocument); return { update, close };
    }),
    canRequest: vi.fn(() => true),
    request: vi.fn(async () => ({ state: 'answered' as const, answer: { kind: 'form' as const, actionId: 'open', outcome: 'submit' as const, values: {} } })),
  };
  const exec = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
  Object.assign(runtime, { exec });
  const host = createSessionsInsights(sessions, ui as unknown as ExtensionUi, lifetime.signal);
  return { lifetime, info, entry, sessions, storage, runtime, ui, exec, host, documents, update, close };
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

it('rejects bad catalogue pagination but marks individual unreadable sessions instead of failing the scan', async () => {
  const h = fixture();
  h.sessions.list.mockResolvedValue({ items: [], nextCursor: 'repeat' });
  await expect(h.host.listSessions(h.runtime)).rejects.toThrow('Insights');
  expect(h.sessions.list).toHaveBeenCalledTimes(2);
  const ok = { ...h.info, id: 'ok', root: 'ok' };
  h.sessions.list.mockResolvedValue({ items: [
    { ...h.info, id: 'missing', diagnostic: 'inaccessible' }, { ...h.info, id: 'large' }, { ...h.info, id: 'busy' }, { ...h.info, id: 'child', root: 'ok' }, ok,
  ] });
  h.sessions.checkpoint.mockImplementation(async id => {
    if (id === 'large') return { sessionId: id, revision: 'large', branch: null, byteLength: SESSION_HISTORY_LIMITS.fileBytes + 1, transcriptDigest: 'digest' };
    if (id === 'busy' || id === 'child') throw new SessionsServiceError(id === 'busy' ? 'stale' : 'unsupported');
    return { sessionId: id, revision: 'journal-v1', branch: 'entry', byteLength: 1000, transcriptDigest: 'digest' };
  });
  const references = await h.host.listSessions(h.runtime);
  expect(references.map(reference => [reference.id, reference.unavailable])).toEqual([
    ['missing', 'inaccessible'], ['large', 'oversize'], ['busy', 'stale'], ['child', 'unsupported'], ['ok', undefined],
  ]);
  expect(references[3]).toMatchObject({ rootSessionId: 'ok', isAgent: true });
  expect(h.sessions.checkpoint.mock.calls.filter(([id]) => id === 'busy')).toHaveLength(3);
  expect(h.sessions.checkpoint.mock.calls.filter(([id]) => id === 'child')).toHaveLength(1);
  await expect(h.host.readSession(h.runtime, references[2]!)).rejects.toThrow('Insights');
  await h.host.dispose();
});

it('retries a listing and checkpoint that went stale while active sessions were written', async () => {
  const h = fixture();
  h.sessions.list.mockRejectedValueOnce(new SessionsServiceError('stale'));
  h.sessions.checkpoint.mockRejectedValueOnce(new SessionsServiceError('stale'));
  const [reference] = await h.host.listSessions(h.runtime);
  expect(reference).toMatchObject({ id: 'root', contentVersion: 'journal-v1' });
  expect(reference).not.toHaveProperty('unavailable');
  expect(h.sessions.list).toHaveBeenCalledTimes(2);
  expect(h.sessions.checkpoint).toHaveBeenCalledTimes(2);
  h.sessions.list.mockRejectedValue(new SessionsServiceError('stale'));
  await expect(h.host.listSessions(h.runtime)).rejects.toMatchObject({ code: 'stale' });
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

function transcriptFor(id: string, project: string, timestamp: string): string {
  return [
    JSON.stringify({ type: 'session', id, cwd: `/workspace/${project}`, timestamp }),
    JSON.stringify({ type: 'message', timestamp, message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
  ].join('\n');
}

function reportFixture(count = 1): InsightsReport {
  const loaded = Array.from({ length: count }, (_, index) => {
    const id = `session-${index}`;
    const session = parseSessionTranscript(transcriptFor(id, index % 2 ? 'project-b' : 'project-a', '2026-01-01T10:00:00Z'), id)!;
    return { rootId: id, session };
  });
  return { path: '/report.html', generatedAt: new Date('2026-01-02T12:00:00Z'), initialRange: '30d', loaded };
}

function invoke(h: ReturnType<typeof fixture>, document: UiDocument, actionId: string, values: Record<string, unknown> = {}) {
  const onAction = h.ui.present.mock.calls.at(-1)![1]!.onAction!;
  return onAction({
    elementId: document.id, revision: document.revision, actionId, outcome: actionId === 'close' ? 'cancel' : 'submit', values,
  } as never, { requestId: actionId, signal: h.lifetime.signal });
}

it('presents a dashboard document whose payload parses and declares only the session actions', async () => {
  const h = fixture();
  await h.host.presentReport!(h.runtime, reportFixture(), undefined);
  const document = h.documents[0]!;
  expect(document).toMatchObject({ kind: 'document', hint: INSIGHTS_DOCUMENT_HINT });
  expect(readInsightsDashboard(document.data).totals.sessions).toBe(1);
  expect(document.actions.map(action => action.id)).toEqual(['range', 'sessions-search', 'open-browser', 'close']);
  expect(document.actions.at(-1)).toMatchObject({ id: 'close', outcome: 'cancel' });
  await h.host.dispose();
  expect(h.close).toHaveBeenCalledOnce();
});

it('recomputes the dashboard for a declared range and rejects undeclared or stale ranges', async () => {
  const h = fixture();
  await h.host.presentReport!(h.runtime, reportFixture(), undefined);
  const first = h.documents[0]!;
  await expect(invoke(h, first, 'range', { range: '1234d' })).rejects.toThrow();
  await invoke(h, first, 'range', { range: '7d' });
  const next = h.documents.at(-1)!;
  expect(readInsightsDashboard(next.data).range).toMatchObject({ id: '7d', label: 'Last 7 days' });
  expect(next.revision).toBeGreaterThan(first.revision);
  await expect(invoke(h, first, 'range', { range: '7d' })).rejects.toThrow();
  await h.host.dispose();
});

it('searches and pages sessions through declared actions only', async () => {
  const h = fixture();
  await h.host.presentReport!(h.runtime, reportFixture(45), undefined);
  let document = h.documents.at(-1)!;
  expect(document.actions.map(action => action.id)).toContain('sessions-next');
  await invoke(h, document, 'sessions-next');
  document = h.documents.at(-1)!;
  expect(readInsightsDashboard(document.data).sessions).toMatchObject({ page: 1, pageCount: 2, matched: 45 });
  expect(readInsightsDashboard(document.data).sessions.rows).toHaveLength(5);
  await invoke(h, document, 'sessions-search', { query: 'project-b' });
  document = h.documents.at(-1)!;
  expect(readInsightsDashboard(document.data).sessions).toMatchObject({ query: 'project-b', page: 0, matched: 22 });
  expect(document.actions.map(action => action.id)).not.toContain('sessions-next');
  await expect(invoke(h, document, 'sessions-next', { query: 'x' })).rejects.toThrow();
  await h.host.dispose();
});

it('opens the report only after host confirmation and reports declined, unavailable and failed attempts', async () => {
  const h = fixture();
  await h.host.presentReport!(h.runtime, reportFixture(), undefined);
  await invoke(h, h.documents[0]!, 'open-browser');
  await vi.waitFor(() => expect(h.exec).toHaveBeenCalledExactlyOnceWith(expect.any(String), ['/report.html']));
  expect(h.ui.request).toHaveBeenCalledWith(expect.objectContaining({ title: 'Open insights report' }), expect.objectContaining({ audience: 'host' }));
  await vi.waitFor(() => expect(readInsightsDashboard(h.documents.at(-1)!.data).notice?.text).toBe('Opened the HTML report on this host.'));

  h.ui.request.mockResolvedValueOnce({ state: 'cancelled', reason: 'user' } as never);
  await invoke(h, h.documents.at(-1)!, 'open-browser');
  await vi.waitFor(() => expect(readInsightsDashboard(h.documents.at(-1)!.data).notice?.text).toBe('Browser open was not confirmed. The HTML report is still saved.'));
  expect(h.exec).toHaveBeenCalledTimes(1);

  h.ui.canRequest.mockReturnValueOnce(false);
  await invoke(h, h.documents.at(-1)!, 'open-browser');
  await vi.waitFor(() => expect(readInsightsDashboard(h.documents.at(-1)!.data).notice?.level).toBe('warning'));
  expect(h.exec).toHaveBeenCalledTimes(1);

  h.exec.mockResolvedValueOnce({ code: 1, stdout: '', stderr: '' });
  await invoke(h, h.documents.at(-1)!, 'open-browser');
  await vi.waitFor(() => expect(readInsightsDashboard(h.documents.at(-1)!.data).notice?.text).toBe('The HTML report could not be opened in the browser.'));
  await h.host.dispose();
});

it('fences stale, foreign and closed actions', async () => {
  const h = fixture();
  await h.host.presentReport!(h.runtime, reportFixture(), undefined);
  const old = h.documents[0]!;
  await expect(invoke(h, { ...old, id: 'foreign' }, 'range', { range: '7d' })).rejects.toThrow();
  await invoke(h, old, 'range', { range: '7d' });
  await expect(invoke(h, old, 'range', { range: '30d' })).rejects.toThrow();
  await invoke(h, h.documents.at(-1)!, 'close');
  expect(h.close).toHaveBeenCalledOnce();
  await expect(invoke(h, h.documents.at(-1)!, 'range', { range: '30d' })).rejects.toThrow();
  await h.host.presentReport!(h.runtime, reportFixture(), undefined);
  await expect(invoke(h, h.documents.at(-1)!, 'range', { range: '30d' })).resolves.toBeUndefined();
  await h.host.dispose();
});

it('joins late presentation creation and reports handle cleanup failures', async () => {
  const h = fixture();
  const entered = deferred<void>();
  const finish = deferred<UiElementHandle>();
  h.ui.present.mockImplementationOnce(async () => { entered.resolve(); return finish.promise; });
  const opening = expect(h.host.presentReport!(h.runtime, reportFixture(), undefined)).rejects.toMatchObject({ name: 'AbortError' });
  await entered.promise;
  let disposed = false;
  const disposal = h.host.dispose().then(() => { disposed = true; });
  expect(disposed).toBe(false);
  finish.resolve({ update: h.update, close: h.close });
  await opening; await disposal;
  expect(h.close).toHaveBeenCalledOnce();
  const failure = fixture();
  await failure.host.presentReport!(failure.runtime, reportFixture(), undefined);
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
