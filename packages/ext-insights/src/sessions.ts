import {
  SESSION_HISTORY_LIMITS, SessionsServiceError,
  type AgentRuntime, type SessionsServiceErrorCode, type ExtensionUi, type SessionsHistory, type SessionCheckpointRef, type SessionHistoryInfo,
  type UiAction, type UiActionContext, type UiActionRequest, type UiDocument, type UiElementHandle,
} from '@felan-ai/agent-core';
import { buildInsightsDashboard, insightsRangeOptions, type InsightsView } from './dashboard.js';
import type { InsightsHost, InsightsReport, InsightsSessionReference } from './contracts.js';
import {
  encodeInsightsDashboard, INSIGHTS_ACTIONS, INSIGHTS_DOCUMENT_HINT, INSIGHTS_QUERY_BYTES, INSIGHTS_QUERY_FIELD,
  INSIGHTS_RANGE_FIELD, insightsRangeLabel, type InsightsDashboard,
} from './data.js';
import { generateDashboardMarkdown } from './markdown.js';
import { openReportOnHost, type OpenReportOutcome } from './open-report.js';

/** Active sessions change between snapshot reads, so a stale answer is retried before the session is skipped. */
const STALE_ATTEMPTS = 3;

export function createSessionsInsights(sessions: SessionsHistory, ui: ExtensionUi, lifetime: AbortSignal): InsightsHost & { dispose(): Promise<void> } {
  const references = new WeakMap<InsightsSessionReference, { info: SessionHistoryInfo; checkpoint: SessionCheckpointRef }>();
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

  const checkpointOf = async (id: string, signal: AbortSignal): Promise<SessionCheckpointRef | SessionsServiceErrorCode> => {
    let checkpoint: SessionCheckpointRef;
    try { checkpoint = await retryStale(() => sessions.checkpoint(id, { signal }), signal); } catch (error) {
      ensure(signal);
      return error instanceof SessionsServiceError ? error.code : 'inaccessible';
    }
    ensure(signal);
    if (checkpoint.sessionId !== id || typeof checkpoint.revision !== 'string' || !checkpoint.revision
      || checkpoint.branch !== null && (typeof checkpoint.branch !== 'string' || !checkpoint.branch)
      || !Number.isSafeInteger(checkpoint.byteLength) || checkpoint.byteLength < 0) return 'invalid';
    return checkpoint.byteLength > SESSION_HISTORY_LIMITS.fileBytes ? 'oversize' : { ...checkpoint };
  };

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
        const checkpoint = info.diagnostic ?? await checkpointOf(info.id, active);
        const lineage = info.id !== info.root ? { rootSessionId: info.root, isAgent: true } : {};
        if (typeof checkpoint === 'string') {
          result.push({ id: info.id, path: info.id, modifiedAtMs: info.updatedAt, unavailable: checkpoint, ...lineage });
          continue;
        }
        const reference: InsightsSessionReference = {
          id: info.id, path: info.id, modifiedAtMs: info.updatedAt, contentVersion: checkpoint.revision, size: checkpoint.byteLength, ...lineage,
        };
        references.set(reference, { info, checkpoint });
        result.push(reference);
      }
      return result;
    }, signal),
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

