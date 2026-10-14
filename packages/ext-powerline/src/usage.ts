import type { ExtensionContext } from '@felan-ai/agent-core';
import type { SessionUsageTotals } from './data.js';

export function getUsageTotals(
  context: ExtensionContext,
  additional?: SessionUsageTotals,
): SessionUsageTotals {
  const totals: SessionUsageTotals = {
    input: additional?.input ?? 0,
    output: additional?.output ?? 0,
    cacheRead: additional?.cacheRead ?? 0,
    cacheWrite: additional?.cacheWrite ?? 0,
    cost: additional?.cost ?? 0,
  };
  for (const entry of context.sessionManager.getEntries()) {
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
    totals.input += entry.message.usage.input;
    totals.output += entry.message.usage.output;
    totals.cacheRead += entry.message.usage.cacheRead;
    totals.cacheWrite += entry.message.usage.cacheWrite;
    totals.cost += entry.message.usage.cost.total;
  }
  return totals;
}

