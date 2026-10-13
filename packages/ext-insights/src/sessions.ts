import {
  SESSION_HISTORY_LIMITS,
  type ExtensionUi, type SessionsHistory, type SessionCheckpointRef, type SessionHistoryInfo,
  type UiActionContext, type UiActionRequest, type UiDocument, type UiElementHandle,
} from '@felan-ai/agent-core';
import type { InsightsHost, InsightsSessionReference } from './contracts.js';
import { generateMarkdown } from './markdown.js';
import { INSIGHTS_DOCUMENT_HINT } from './ui.js';

export function createSessionsInsights(sessions: SessionsHistory, ui: ExtensionUi, lifetime: AbortSignal): InsightsHost & { dispose(): Promise<void> } {
  const references = new WeakMap<InsightsSessionReference, { info: SessionHistoryInfo; checkpoint: SessionCheckpointRef }>();
  const pending = new Set<Promise<unknown>>();
  const controller = new AbortController();
  const scope = AbortSignal.any([lifetime, controller.signal]);
  let disposed = false;
  let report = '';
  let revision = 0;
  let presentation: { handle?: UiElementHandle; document: UiDocument; closed: boolean; queue: Promise<void> } | undefined;
  let presentationQueue = Promise.resolve();
  let cleanup: Promise<void> | undefined;
  const ensure = (signal = scope) => {
    if (signal.aborted) throw new DOMException('Insights request cancelled.', 'AbortError');
    if (disposed) throw new Error('Insights session is disposed.');
  };
  const track = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  };
  const run = <T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> => track((async () => {
    const active = signal ? AbortSignal.any([scope, signal]) : scope;
    try { ensure(active); const value = await operation(active); ensure(active); return value; }
    catch { throw active.aborted ? new DOMException('Insights request cancelled.', 'AbortError') : new Error('Insights session operation failed.'); }
  })());

  async function* readLines(reference: InsightsSessionReference, signal?: AbortSignal): AsyncIterable<string> {
    const active = signal ? AbortSignal.any([scope, signal]) : scope;
    ensure(active);
    const selected = references.get(reference);
    if (!selected) throw new Error('Insights history reference is not visible.');
    let bytes = 0;
    let headerPending = true;
    const cursors = new Set<string>();
    const ids = new Set<string>();
    let cursor: string | undefined;
    const at = { sessionId: selected.info.id, revision: selected.checkpoint.revision, branch: selected.checkpoint.branch };
    do {
      ensure(active);
      const page = await run(requestSignal => sessions.history(selected.info.id, {
        signal: requestSignal, limit: SESSION_HISTORY_LIMITS.pageEntries, at, ...(cursor === undefined ? {} : { cursor }),
      }), active);
      if (page.sessionId !== at.sessionId || page.revision !== at.revision || page.branch !== at.branch || !Array.isArray(page.entries)
        || page.entries.length > SESSION_HISTORY_LIMITS.pageEntries) throw new Error('Insights history snapshot changed.');
      if (headerPending) {
        const header = JSON.stringify({ type: 'session', id: selected.info.id, cwd: selected.info.cwd,
          ...(page.startedAt === undefined ? {} : { timestamp: page.startedAt }) });
        bytes += new TextEncoder().encode(header).byteLength;
        headerPending = false;
        yield header;
      }
      for (const entry of page.entries) {
        ensure(active);
        if (!entry || !entry.id || ids.has(entry.id)) throw new Error('Insights history contains invalid entries.');
        ids.add(entry.id);
        const line = JSON.stringify(entry);
        bytes += new TextEncoder().encode(line).byteLength + 1;
        if (bytes > SESSION_HISTORY_LIMITS.fileBytes) throw new Error('Session transcript exceeds the supported size.');
        yield line;
      }
      cursor = nextCursor(page.nextCursor, cursors);
    } while (cursor !== undefined);
  }

  const write = (runtime: Parameters<InsightsHost['writeReport']>[0], name: string, content: string) => run(async () => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(name) || name.includes('..')) throw new Error('Invalid report name.');
    const storage = runtime.storage('agent');
    await storage.mkdir('insights-reports', { recursive: true });
    ensure();
    await storage.writeFile(`insights-reports/${name}`, new TextEncoder().encode(content));
    return `${storage.root}/insights-reports/${name}`;
  });

  return {
    listSessions: (_runtime, signal) => run(async active => {
      const result: InsightsSessionReference[] = [];
      const cursors = new Set<string>();
      const ids = new Set<string>();
      let cursor: string | undefined;
      do {
        ensure(active);
        const page = await sessions.list({ scope: 'visible' }, { signal: active, limit: SESSION_HISTORY_LIMITS.pageEntries, ...(cursor === undefined ? {} : { cursor }) });
        ensure(active);
        if (!Array.isArray(page.items) || page.items.length > SESSION_HISTORY_LIMITS.pageEntries) throw new Error('Invalid session page.');
        for (const info of page.items) {
          if (!info.id || ids.has(info.id) || info.diagnostic) throw new Error('Session history is inaccessible.');
          ids.add(info.id);
          const checkpoint = await sessions.checkpoint(info.id, { signal: active });
          ensure(active);
          if (checkpoint.sessionId !== info.id || typeof checkpoint.revision !== 'string' || !checkpoint.revision
            || checkpoint.branch !== null && (typeof checkpoint.branch !== 'string' || !checkpoint.branch)
            || !Number.isSafeInteger(checkpoint.byteLength) || checkpoint.byteLength < 0
            || checkpoint.byteLength > SESSION_HISTORY_LIMITS.fileBytes) throw new Error('Session checkpoint is invalid.');
          const reference: InsightsSessionReference = {
            id: info.id, path: info.id, modifiedAtMs: info.updatedAt, contentVersion: checkpoint.revision, size: checkpoint.byteLength,
            ...(info.id !== info.root ? { rootSessionId: info.root, isAgent: true } : {}),
          };
          references.set(reference, { info: { ...info }, checkpoint: { ...checkpoint } });
          result.push(reference);
        }
        cursor = nextCursor(page.nextCursor, cursors);
      } while (cursor !== undefined);
      return result;
    }, signal),
    readSessionLines: (_runtime, reference, signal) => readLines(reference, signal),
    readSession: (_runtime, reference, signal) => run(async active => {
      const lines: string[] = [];
      for await (const line of readLines(reference, active)) lines.push(line);
      return lines.join('\n');
    }, signal),
    enrichAnalytics: analytics => run(async () => { report = generateMarkdown(analytics); return analytics; }),
    writeReport: write,
    writeMarkdown: write,
    openReport: (_runtime, _path, signal) => run(active => {
      const opening = presentationQueue.then(async () => {
        ensure(active);
        if (presentation) {
          presentation.closed = true;
          await presentation.queue;
          await presentation.handle?.close();
        }
        ensure(active);
        const pages = markdownPages(report || 'No report content.');
        let page = 0;
        const document = (index = page): UiDocument => ({
          id: 'insights-report', kind: 'document', revision: ++revision, hint: INSIGHTS_DOCUMENT_HINT,
          title: `Session insights (${index + 1}/${pages.length})`, fallback: `Session insights, page ${index + 1} of ${pages.length}`,
          markdown: pages[index]!, actions: [
            ...(index ? [{ id: 'previous', label: 'Previous', target: 'element' as const, outcome: 'submit' as const }] : []),
            ...(index + 1 < pages.length ? [{ id: 'next', label: 'Next', target: 'element' as const, outcome: 'submit' as const }] : []),
            { id: 'close', label: 'Close report', target: 'element' as const, outcome: 'cancel' as const },
          ],
        });
        const view = { document: document(), closed: false, queue: Promise.resolve(), handle: undefined as UiElementHandle | undefined };
        presentation = view;
        const onAction = (action: UiActionRequest, context: UiActionContext) => run(actionSignal => {
          const task = view.queue.then(async () => {
            ensure(active); ensure(actionSignal);
            if (view.closed || presentation !== view || action.elementId !== view.document.id || action.revision !== view.document.revision
              || action.itemId !== undefined || action.outcome !== (action.actionId === 'close' ? 'cancel' : 'submit') || !action.values || typeof action.values !== 'object'
              || Array.isArray(action.values) || Object.keys(action.values).length
              || !view.document.actions.some(candidate => candidate.id === action.actionId)) throw new Error('Report action is unavailable.');
            if (action.actionId === 'close') { view.closed = true; await view.handle!.close(); return; }
            const nextPage = page + (action.actionId === 'previous' ? -1 : 1);
            const next = document(nextPage);
            try { await view.handle!.update(next); }
            catch (error) { view.closed = true; throw error; }
            page = nextPage;
            view.document = next;
            ensure(active); ensure(actionSignal);
          });
          view.queue = task.catch(() => {});
          return task;
        }, context.signal);
        view.handle = await ui.present(view.document, { signal: active, onAction });
      });
      presentationQueue = opening.catch(() => {});
      return opening;
    }, signal),
    dispose() {
      disposed = true;
      controller.abort();
      cleanup ??= (async () => {
        while (pending.size) await Promise.allSettled([...pending]);
        await presentationQueue;
        if (presentation) { presentation.closed = true; await presentation.handle?.close(); }
      })();
      return cleanup;
    },
  };
}

function nextCursor(value: string | undefined, seen: Set<string>): string | undefined {
  if (value !== undefined) {
    if (typeof value !== 'string' || !value || value.length > 4096 || seen.has(value)) throw new Error('Invalid session cursor.');
    seen.add(value);
  }
  return value;
}

function markdownPages(text: string): string[] {
  if (new TextEncoder().encode(text).byteLength > SESSION_HISTORY_LIMITS.fileBytes) throw new Error('Report exceeds the supported size.');
  const pages: string[] = [];
  let page = '';
  let bytes = 0;
  for (const char of text) {
    const escaped = char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;'
      : /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(char) ? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
        : /[\\`*_{}\[\]()#+.!|~\-]/u.test(char) ? `\\${char}` : char;
    const size = new TextEncoder().encode(escaped).byteLength;
    if (bytes + size > 24_000) { pages.push(page); page = ''; bytes = 0; }
    page += escaped; bytes += size;
  }
  if (page || !pages.length) pages.push(page || '(empty report)');
  return pages;
}
