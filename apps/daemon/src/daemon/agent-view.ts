import { AgentSummarySchema, parseSchema, type AgentSummary, type Presentation } from '@felan-ai/session-protocol';
import { AGENT_VIEW_PRESENTER } from '@felan-ai/ext-subagents/view';
import type { LocalSubagentView } from '../subagents/host.js';
import type { LocalSubagentNavigatorHost } from '../subagents/presentation.js';
import { ControlStoreError } from './control-state.js';
import { boundedText, digest } from './projection.js';

export function agentSummary(row: LocalSubagentView): AgentSummary {
  const model = row.model ?? (row.session?.model ? `${row.session.model.provider}/${row.session.model.id}` : undefined);
  return parseSchema(AgentSummarySchema, { agentId: row.agentId, parentSessionId: row.parentSessionId, rootSessionId: row.rootSessionId,
    type: row.type, description: row.description, status: row.status, createdAt: row.createdAt, resultAvailable: row.result !== undefined,
    ...(row.startedAt === undefined ? {} : { startedAt: row.startedAt }), ...(row.completedAt === undefined ? {} : { completedAt: row.completedAt }),
    ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }), ...(model === undefined ? {} : { model }),
    ...(row.usage === undefined ? {} : { usage: row.usage }),
    ...(row.error === undefined ? {} : { error: { ...row.error, message: boundedText(row.error.message, 64 * 1024) } }) });
}

export function publishAgentView(host: LocalSubagentNavigatorHost, publish: (value: Presentation) => void, onError: (error: unknown) => void): () => void {
  let stopped = false; let pending: string | undefined; let committed: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const releases: Array<() => void> = [];
  const stop = () => { stopped = true; if (timer) clearTimeout(timer); timer = undefined; for (const release of releases.splice(0)) release(); };
  const flush = () => {
    if (stopped || pending === undefined || pending === committed) return;
    try {
      publish({ id: AGENT_VIEW_PRESENTER.id, kind: 'custom', presenter: AGENT_VIEW_PRESENTER, data: { generation: pending } });
      committed = pending; pending = undefined;
    } catch (error) {
      if (error instanceof ControlStoreError && error.code === 'request_capacity'
        && (error.message === 'Control capacity is reserved for outcomes and safety operations.' || error.message === 'Presentation capacity reached.')) {
        timer ??= setTimeout(() => { timer = undefined; flush(); }, 1_000); timer.unref();
      } else { stop(); onError(error); }
    }
  };
  const changed = () => {
    if (stopped) return;
    try { pending = digest(host.listLocalSubagents().map(agentSummary)); flush(); }
    catch (error) { stop(); onError(error); }
  };
  const records = host.subscribe?.(changed); if (records) releases.push(records);
  const usage = host.subscribeUsage?.(changed); if (usage) releases.push(usage);
  if (stopped) stop(); else changed();
  return stop;
}
