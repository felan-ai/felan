import {
  SESSION_HISTORY_LIMITS, SessionsServiceError,
  type ExtensionUi, type HistoryRevision, type SessionsHistory, type SessionHistoryInfo,
  type UiAction, type UiActionContext, type UiActionRequest, type UiDocument, type UiElementHandle,
} from '@felan-ai/agent-core';
import { buildInsightsDashboard, insightsRangeOptions, type InsightsView } from './dashboard.js';
import type { InsightsHost, InsightsSessionReference } from './contracts.js';
import {
  encodeInsightsDashboard, INSIGHTS_ACTIONS, INSIGHTS_DOCUMENT_HINT, INSIGHTS_QUERY_BYTES, INSIGHTS_QUERY_FIELD,
  INSIGHTS_RANGE_FIELD, insightsRangeLabel, type InsightsDashboard,
} from './data.js';
import { generateDashboardMarkdown } from './markdown.js';
import { openReportOnHost, type OpenReportOutcome } from './open-report.js';
import type { SessionEvent } from './types.js';

/** Active sessions change between page reads, so a stale answer is retried before the session is skipped. */
const STALE_ATTEMPTS = 3;

export function createSessionsInsights(sessions: SessionsHistory, ui: ExtensionUi, lifetime: AbortSignal): InsightsHost & { dispose(): Promise<void> } {
  const references = new WeakMap<InsightsSessionReference, SessionHistoryInfo>();
  const pending = new Set<Promise<unknown>>();
  const controller = new AbortController();
  const scope = AbortSignal.any([lifetime, controller.signal]);
  let disposed = false;
  let revision = 0;
  let presentation: { handle?: UiElementHandle; document: UiDocument; closed: boolean; queue: Promise<void>; lifetime: AbortController } | undefined;
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
    catch (error) {
      if (active.aborted) throw new DOMException('Insights request cancelled.', 'AbortError');
      throw error instanceof SessionsServiceError ? new SessionsServiceError(error.code) : new Error('Insights session operation failed.');
    }
  })());

  const retryStale = async <T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try { return await operation(); } catch (error) {
        ensure(signal);
        if (attempt >= STALE_ATTEMPTS || !(error instanceof SessionsServiceError && error.code === 'stale')) throw error;
      }
    }
  };

  const listVisible = (signal: AbortSignal) => retryStale(async () => {
    const items: SessionHistoryInfo[] = [];
    const cursors = new Set<string>();
    const ids = new Set<string>();
    let cursor: string | undefined;
    do {
      ensure(signal);
      const page = await sessions.list({ scope: 'visible' }, { signal, limit: SESSION_HISTORY_LIMITS.pageEntries, ...(cursor === undefined ? {} : { cursor }) });
      ensure(signal);
      if (!Array.isArray(page.items) || page.items.length > SESSION_HISTORY_LIMITS.pageEntries) throw new Error('Invalid session page.');
      for (const info of page.items) {
        if (!info.id || ids.has(info.id)) throw new Error('Invalid session page.');
        ids.add(info.id);
        items.push({ ...info });
      }
      cursor = nextCursor(page.nextCursor, cursors);
    } while (cursor !== undefined);
    return items;
  }, signal);

  // The first page pins the revision for the remaining pages, so no separate checkpoint read is needed.
  const readPages = async (info: SessionHistoryInfo, active: AbortSignal): Promise<SessionEvent[]> => {
    const events: SessionEvent[] = [];
    const cursors = new Set<string>();
    const ids = new Set<string>();
    let cursor: string | undefined;
    let at: HistoryRevision | undefined;
    do {
      ensure(active);
      const page = await run(requestSignal => sessions.history(info.id, {
        signal: requestSignal, limit: SESSION_HISTORY_LIMITS.pageEntries, ...(at === undefined ? {} : { at }), ...(cursor === undefined ? {} : { cursor }),
      }), active);
      if (page.sessionId !== info.id || typeof page.revision !== 'string' || !page.revision
        || page.branch !== null && (typeof page.branch !== 'string' || !page.branch)
        || at && (page.revision !== at.revision || page.branch !== at.branch) || !Array.isArray(page.entries)
        || page.entries.length > SESSION_HISTORY_LIMITS.pageEntries) throw new Error('Insights history snapshot changed.');
      if (!at) {
        at = { sessionId: info.id, revision: page.revision, branch: page.branch };
        events.push({ type: 'session', id: info.id, cwd: info.cwd, ...(page.startedAt === undefined ? {} : { timestamp: page.startedAt }) });
      }
      for (const entry of page.entries) {
        ensure(active);
        if (!entry || !entry.id || ids.has(entry.id)) throw new Error('Insights history contains invalid entries.');
        ids.add(entry.id);
        events.push(entry);
      }
      cursor = nextCursor(page.nextCursor, cursors);
    } while (cursor !== undefined);
    return events;
  };

  const readEntries = (reference: InsightsSessionReference, signal?: AbortSignal) => run(active => {
    const info = references.get(reference);
    if (!info) throw new Error('Insights history reference is not visible.');
    return retryStale(() => readPages(info, active), active);
  }, signal);

  async function* readLines(reference: InsightsSessionReference, signal?: AbortSignal): AsyncIterable<string> {
    const lines: string[] = [];
    let bytes = 0;
    for (const event of await readEntries(reference, signal)) {
      const line = JSON.stringify(event);
      bytes += new TextEncoder().encode(line).byteLength + (lines.length ? 1 : 0);
      if (bytes > SESSION_HISTORY_LIMITS.fileBytes) throw new SessionsServiceError('oversize', 'Session transcript exceeds the supported size.');
      lines.push(line);
    }
    yield* lines;
  }

  const write = (runtime: Parameters<InsightsHost['writeReport']>[0], name: string, content: string) => run(async () => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(name) || name.includes('..')) throw new Error('Invalid report name.');
    const storage = runtime.storage('agent');
    await storage.mkdir('insights-reports', { recursive: true });
    ensure();
    await storage.writeFile(`insights-reports/${name}`, new TextEncoder().encode(content));
    return `${storage.root}/insights-reports/${name}`;
  });

  const notice = (outcome: OpenReportOutcome, path: string): NonNullable<InsightsView['notice']> => {
    switch (outcome) {
      case 'opened': return { level: 'info', text: 'Opened the HTML report on this host.' };
      case 'declined': return { level: 'info', text: 'Browser open was not confirmed. The HTML report is still saved.' };
      case 'unavailable': return { level: 'warning', text: `Opening ${path} needs a local console on this host.` };
      case 'failed': return { level: 'warning', text: 'The HTML report could not be opened in the browser.' };
    }
  };

  return {
    listSessions: (_runtime, signal) => run(async active => {
      // One session that is missing, unsupported or changing must not hide the rest of the history.
      const result: InsightsSessionReference[] = [];
      for (const info of await listVisible(active)) {
        const lineage = info.id !== info.root ? { rootSessionId: info.root, isAgent: true } : {};
        const reference: InsightsSessionReference = {
          id: info.id, path: info.id, modifiedAtMs: info.updatedAt, ...lineage, ...(info.diagnostic ? { unavailable: info.diagnostic } : {}),
        };
        if (!info.diagnostic) references.set(reference, info);
        result.push(reference);
      }
      return result;
    }, signal),
    readSessionEntries: (_runtime, reference, signal) => readEntries(reference, signal),
    readSessionLines: (_runtime, reference, signal) => readLines(reference, signal),
    readSession: (_runtime, reference, signal) => run(async active => {
      const lines: string[] = [];
      for await (const line of readLines(reference, active)) lines.push(line);
      return lines.join('\n');
    }, signal),
    writeReport: write,
    writeMarkdown: write,
    presentReport: (runtime, report, signal) => run(active => {
      const opening = presentationQueue.then(async () => {
        ensure(active);
        if (presentation) {
          presentation.closed = true;
          presentation.lifetime.abort();
          await presentation.queue;
          await presentation.handle?.close();
        }
        ensure(active);
        const rangeOptions = insightsRangeOptions(report.initialRange);
        let view: InsightsView = { range: report.initialRange, query: '', page: 0 };
        const dashboardDocument = (): UiDocument => {
          const dashboard = buildInsightsDashboard(report, view);
          const data = encodeInsightsDashboard(dashboard);
          return {
            id: 'insights-report', kind: 'document', revision: ++revision,
            title: `Session insights (${dashboard.range.label})`,
            fallback: `Session insights, ${dashboard.range.label}`,
            markdown: generateDashboardMarkdown(dashboard),
            ...(data === undefined ? {} : { data, hint: INSIGHTS_DOCUMENT_HINT }),
            actions: dashboardActions(dashboard, rangeOptions),
          };
        };
        const shown = {
          document: dashboardDocument(), closed: false, queue: Promise.resolve(), lifetime: new AbortController(),
          handle: undefined as UiElementHandle | undefined,
        };
        presentation = shown;
        const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
          const result = shown.queue.then(work);
          shown.queue = result.then(() => undefined, () => undefined);
          return result;
        };
        const refresh = async () => {
          const next = dashboardDocument();
          try { await shown.handle!.update(next); }
          catch (error) { shown.closed = true; throw error; }
          shown.document = next;
        };
        const confirmOpen = () => {
          const outcome = (async () => {
            const result = await openReportOnHost({ ui, runtime, path: report.path, signal: AbortSignal.any([scope, shown.lifetime.signal]) });
            await enqueue(async () => {
              if (shown.closed || presentation !== shown) return;
              view = { ...view, notice: notice(result, report.path) };
              await refresh();
            });
          })();
          void track(outcome.catch(() => {}));
        };
        const onAction = (action: UiActionRequest, context: UiActionContext) => run(actionSignal => enqueue(async () => {
          ensure(active); ensure(actionSignal);
          const declared = shown.document.actions.find(candidate => candidate.id === action.actionId);
          if (shown.closed || presentation !== shown || action.elementId !== shown.document.id || action.revision !== shown.document.revision
            || action.itemId !== undefined || !declared || action.outcome !== declared.outcome
            || !action.values || typeof action.values !== 'object' || Array.isArray(action.values)) throw new Error('Insights action is unavailable.');
          if (action.actionId === INSIGHTS_ACTIONS.close) {
            shown.closed = true;
            shown.lifetime.abort();
            await shown.handle!.close();
            return;
          }
          const values = action.values as Record<string, unknown>;
          const expected = action.actionId === INSIGHTS_ACTIONS.range ? [INSIGHTS_RANGE_FIELD]
            : action.actionId === INSIGHTS_ACTIONS.search ? [INSIGHTS_QUERY_FIELD] : [];
          if (Object.keys(values).length !== expected.length || expected.some(key => !Object.hasOwn(values, key))) throw new Error('Insights action is unavailable.');
          const base = { range: view.range, query: view.query, page: view.page };
          if (action.actionId === INSIGHTS_ACTIONS.range) {
            const range = values[INSIGHTS_RANGE_FIELD];
            if (typeof range !== 'string' || !rangeOptions.includes(range)) throw new Error('Insights action is unavailable.');
            view = { ...base, range, page: 0 };
          } else if (action.actionId === INSIGHTS_ACTIONS.search) {
            const query = values[INSIGHTS_QUERY_FIELD];
            if (typeof query !== 'string' || new TextEncoder().encode(query).byteLength > INSIGHTS_QUERY_BYTES) throw new Error('Insights action is unavailable.');
            view = { ...base, query, page: 0 };
          } else if (action.actionId === INSIGHTS_ACTIONS.previous) {
            view = { ...base, page: base.page - 1 };
          } else if (action.actionId === INSIGHTS_ACTIONS.next) {
            view = { ...base, page: base.page + 1 };
          } else {
            view = { ...base, notice: { level: 'info', text: 'Confirm on this host to open the HTML report.' } };
          }
          await refresh();
          if (action.actionId === INSIGHTS_ACTIONS.openBrowser) confirmOpen();
        }), context.signal);
        shown.handle = await ui.present(shown.document, { signal: active, onAction });
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
        if (presentation) { presentation.closed = true; presentation.lifetime.abort(); await presentation.handle?.close(); }
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


function dashboardActions(dashboard: InsightsDashboard, rangeOptions: readonly string[]): UiAction[] {
  const { page, pageCount, query } = dashboard.sessions;
  return [
    { id: INSIGHTS_ACTIONS.range, label: 'Range', target: 'element', outcome: 'submit', input: {
      fields: [{ id: INSIGHTS_RANGE_FIELD, kind: 'enum', label: 'Range', required: true, options: rangeOptions.map(id => ({ id, label: insightsRangeLabel(id) })) }],
      defaults: { [INSIGHTS_RANGE_FIELD]: dashboard.range.id },
    } },
    { id: INSIGHTS_ACTIONS.search, label: 'Search sessions', target: 'element', outcome: 'submit', input: {
      fields: [{ id: INSIGHTS_QUERY_FIELD, kind: 'string', label: 'Search', required: false, maxLength: INSIGHTS_QUERY_BYTES, placeholder: 'Project, model or start date' }],
      defaults: { [INSIGHTS_QUERY_FIELD]: query },
    } },
    ...(page > 0 ? [{ id: INSIGHTS_ACTIONS.previous, label: 'Previous sessions', target: 'element' as const, outcome: 'submit' as const }] : []),
    ...(page + 1 < pageCount ? [{ id: INSIGHTS_ACTIONS.next, label: 'Next sessions', target: 'element' as const, outcome: 'submit' as const }] : []),
    { id: INSIGHTS_ACTIONS.openBrowser, label: 'Open in browser', target: 'element', outcome: 'submit' },
    { id: INSIGHTS_ACTIONS.close, label: 'Close', target: 'element', outcome: 'cancel' },
  ];
}

