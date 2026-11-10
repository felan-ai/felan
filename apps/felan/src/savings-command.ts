import { join } from 'node:path';
import {
  ExtensionUiUnavailableError, HostAgentRuntime, SESSION_HISTORY_LIMITS, SESSIONS_HISTORY_SERVICE, SessionsServiceError, bindFelanExtension,
  type FelanExtension, type InlineExtension, type SessionsHistory, type UiActionContext, type UiActionRequest, type UiDocument, type UiElementHandle,
} from '@felan-ai/agent-core';
import type { SessionExtensionContext } from '@felan-ai/daemon/provider';
import { SavingsService, formatSavingsReport, type SavingsQuery, type SavingsReport } from './providers/savings.js';
import { createSavingsDashboard, savingsDashboardMarkdown, type SavingsSessionLabel } from './savings/dashboard.js';
import {
  SAVINGS_ACTIONS, SAVINGS_DASHBOARD_HINT, SAVINGS_RANGES, formatSavingsUsd, savingsRangeLabel, type SavingsRangeId, type SavingsTabId,
} from './savings/data.js';

const SAVINGS_COMMAND_EXTENSION_NAME = '@felan-ai/felan/savings';
const USAGE = 'Usage: /savings [today|7d|30d|90d|all] [project|details]';
const TAB_ALIASES: Readonly<Record<string, SavingsTabId>> = { project: 'projects', details: 'extensions' };
const DOCUMENT_ID = 'savings-dashboard';
const STALE_ATTEMPTS = 3;

export type SavingsCommandContext = Pick<SessionExtensionContext, 'runtime' | 'resources' | 'services' | 'createExtensionUi'>;
interface SavingsCommandOptions { readonly range?: SavingsRangeId; readonly tab?: SavingsTabId }
interface ShownDashboard { handle?: UiElementHandle; document: UiDocument; closed: boolean }

export function createSavingsCommandExtension(service: SavingsService, context: SavingsCommandContext): InlineExtension {
  const extension = bindFelanExtension(SAVINGS_COMMAND_EXTENSION_NAME, createSavingsExtension(service), context.runtime, context.resources.agentDir,
    {}, undefined, context.services, { optional: [SESSIONS_HISTORY_SERVICE] }, context.createExtensionUi);
  return typeof extension === 'function' ? { name: SAVINGS_COMMAND_EXTENSION_NAME, factory: extension, hidden: true } : { ...extension, hidden: true };
}

/** @internal */
export function parseSavingsArgs(args: string): SavingsCommandOptions | undefined {
  const words = args.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  let range: SavingsRangeId | undefined;
  let tab: SavingsTabId | undefined;
  for (const word of words) {
    if ((SAVINGS_RANGES as readonly string[]).includes(word) && range === undefined) range = word as SavingsRangeId;
    else if (TAB_ALIASES[word] && tab === undefined) tab = TAB_ALIASES[word];
    else return undefined;
  }
  return { ...(range ? { range } : {}), ...(tab ? { tab } : {}) };
}

/** @internal */
export function createSavingsExtension(service: SavingsService): FelanExtension {
  return (pi) => {
    const lifetime = new AbortController();
    let revision = 0;
    let shown: ShownDashboard | undefined;
    pi.on('session_shutdown', () => { lifetime.abort(); });

    const build = async (options: SavingsCommandOptions): Promise<{ document: UiDocument; report: SavingsReport }> => {
      await service.settle();
      const report = await service.query({ scope: 'all' });
      const sessions = await sessionLabels(pi.services.get(SESSIONS_HISTORY_SERVICE), lifetime.signal);
      const { dashboard, data } = createSavingsDashboard({
        buckets: report.buckets, diagnostics: report.diagnostics, now: new Date(),
        currentSessionId: service.rootSessionId, currentProjectKey: service.projectKey, currentProjectCwd: pi.runtime.cwd, sessions,
        ...(options.range ? { initialRange: options.range } : {}), ...(options.tab ? { initialTab: options.tab } : {}),
      });
      const initial = dashboard.ranges.find(range => range.id === dashboard.initialRange)!;
      const summary = `${formatSavingsUsd(initial.totals.savedUsd)} saved, ${savingsRangeLabel(initial.id).toLowerCase()}`;
      return { report, document: {
        id: DOCUMENT_ID, kind: 'document', revision: ++revision, title: 'Estimated savings', fallback: `Estimated savings: ${summary}`,
        markdown: savingsDashboardMarkdown(dashboard), ...(data ? { data, hint: SAVINGS_DASHBOARD_HINT } : {}),
        actions: [
          { id: SAVINGS_ACTIONS.refresh, label: 'Refresh', target: 'element', outcome: 'submit' },
          { id: SAVINGS_ACTIONS.close, label: 'Close', target: 'element', outcome: 'cancel' },
        ],
      } };
    };

    const onAction = async (current: ShownDashboard, action: UiActionRequest, _context: UiActionContext) => {
      const declared = current.document.actions.find(candidate => candidate.id === action.actionId);
      if (current.closed || shown !== current || action.elementId !== current.document.id || action.revision !== current.document.revision
        || action.itemId !== undefined || !declared || action.outcome !== declared.outcome || Object.keys(action.values ?? {}).length) {
        throw new Error('Savings action is unavailable.');
      }
      if (action.actionId === SAVINGS_ACTIONS.close) {
        current.closed = true;
        shown = undefined;
        await current.handle?.close();
        return;
      }
      const { document } = await build({});
      if (current.closed) return;
      await current.handle!.update(document);
      current.document = document;
    };

    pi.registerCommand('savings', {
      description: 'Show estimated API-equivalent savings by session, extension, project and period',
      getArgumentCompletions: (prefix) => {
        const words = prefix.trimStart().toLowerCase().split(/\s+/u);
        const current = words.pop() ?? '';
        const chosen = words.length > 1 ? undefined : parseSavingsArgs(words.join(' '));
        if (!chosen) return null;
        // Pi replaces the whole argument text, so a second-word completion repeats the first word.
        const lead = words.length ? `${words[0]} ` : '';
        return [...(chosen.range ? [] : SAVINGS_RANGES), ...(chosen.tab ? [] : Object.keys(TAB_ALIASES))]
          .filter(entry => entry.startsWith(current)).map(entry => ({ value: `${lead}${entry}`, label: entry }));
      },
      handler: async (args, ctx) => {
        const options = parseSavingsArgs(args);
        if (!options) { ctx.ui.notify(USAGE, 'warning'); return; }
        const previous = shown;
        shown = undefined;
        if (previous) { previous.closed = true; await previous.handle?.close(); }
        const { document, report } = await build(options);
        const current: ShownDashboard = { document, closed: false };
        shown = current;
        try {
          current.handle = await pi.ui.present(document, { signal: lifetime.signal, onAction: (action, context) => onAction(current, action, context) });
        } catch (error) {
          if (shown === current) shown = undefined;
          if (!(error instanceof ExtensionUiUnavailableError)) throw error;
          ctx.ui.notify(formatSavingsReport(report, true), 'info');
        }
      },
    });
  };
}

async function sessionLabels(sessions: SessionsHistory | undefined, signal: AbortSignal): Promise<Map<string, SavingsSessionLabel>> {
  let labels = new Map<string, SavingsSessionLabel>();
  if (!sessions) return labels;
  for (let attempt = 1; attempt <= STALE_ATTEMPTS; attempt++) {
    labels = new Map();
    const seen = new Set<string>();
    try {
      let cursor: string | undefined;
      do {
        const page = await sessions.list({ scope: 'visible' }, { signal, limit: SESSION_HISTORY_LIMITS.pageEntries, ...(cursor === undefined ? {} : { cursor }) });
        for (const info of page.items) labels.set(info.id, { title: info.title, cwd: info.cwd });
        cursor = page.nextCursor;
        if (cursor !== undefined && seen.has(cursor)) break;
        if (cursor !== undefined) seen.add(cursor);
      } while (cursor !== undefined);
      return labels;
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof SessionsServiceError && error.code === 'stale')) break;
    }
  }
  return labels;
}

export async function runLocalSavingsCli(options: {
  readonly agentDir: string;
  readonly cwd: string;
  readonly sessionId?: string;
  readonly projectKey: string;
  readonly query: SavingsQuery;
  readonly format: 'text' | 'json';
  readonly writeOutput: (line: string) => void;
}): Promise<number> {
  const runtime = new HostAgentRuntime(options.cwd, {
    sessionStorageRoot: join(options.agentDir, 'storage', 'sessions', 'cli'),
    agentStorageRoot: join(options.agentDir, 'storage', 'agent'),
    agentDir: options.agentDir,
    pathAccess: 'host',
  });
  const service = new SavingsService({
    runtime,
    rootSessionId: options.sessionId ?? 'cli',
    projectKey: options.projectKey,
  });
  const report = await service.query(options.query);
  options.writeOutput(options.format === 'json' ? JSON.stringify(report) : formatSavingsReport(report, true));
  return 0;
}
