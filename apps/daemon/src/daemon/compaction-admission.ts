import { buildSessionProjection, estimateTokens, type ProjectedSessionEntry } from '@earendil-works/pi-coding-agent';
import type { AgentSession } from '@felan-ai/agent-core';

const CUT_POINT_ROLES = new Set(['user', 'assistant', 'bashExecution', 'custom', 'branchSummary', 'compactionSummary']);

/**
 * Pi does not export prepareCompaction(), so this predicts only the cases where it certainly finds nothing to summarize
 * and AgentSession.compact() would end the run without a compaction. Since the latest compaction, Pi keeps the newest
 * keepRecentTokens, counting the system prompt, and cuts at a message that can start the kept context. When that cut is
 * the first such message, nothing older is left. Cases this does not decide are left to AgentSession.compact().
 */
export function compactionUnavailableMessage(session: AgentSession): string | undefined {
  const branch = session.sessionManager.getBranch();
  if (branch.at(-1)?.type === 'compaction') return 'Already compacted. Send another message before compacting again.';
  const { keepRecentTokens } = session.settingsManager.getCompactionSettings(session.model);
  const { entries } = buildSessionProjection(branch);
  const since = entries.slice(entries.findIndex(entry => entry.sourceEntry.type === 'compaction' && entry.messages.length > 0) + 1);
  const first = since.findIndex(isCutPoint);
  if (first !== -1) {
    if (since.slice(0, first).some(entry => entry.messages.some(message => message.role !== 'system')) || since.some(isOmittedAssistant)) return undefined;
    const later = since.slice(first + 1);
    if (later.some(isCutPoint) && tokens(later) >= keepRecentTokens) return undefined;
  }
  return `Nothing to compact yet. Compaction keeps the most recent ${keepRecentTokens.toLocaleString('en-US')} tokens of context, and this session has no older messages to summarize.`;
}

function isCutPoint(entry: ProjectedSessionEntry): boolean {
  return entry.sourceEntry.type !== 'compaction' && entry.messages.some(message => CUT_POINT_ROLES.has(message.role));
}

function isOmittedAssistant(entry: ProjectedSessionEntry): boolean {
  return entry.sourceEntry.type === 'message' && entry.sourceEntry.message.role === 'assistant' && entry.messages.length === 0;
}

function tokens(entries: readonly ProjectedSessionEntry[]): number {
  let total = 0;
  for (const entry of entries) for (const message of entry.messages) total += estimateTokens(message);
  return total;
}
