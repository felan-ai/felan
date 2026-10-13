import type { SessionsService, UsageService } from '@felan-ai/agent-core';
import type { PowerlineRuntimeOptions } from './runtime.js';
import type { SessionUsageTotals } from './segments.js';

export function createSavingsUsage(usage: UsageService): NonNullable<PowerlineRuntimeOptions['savingsHost']> {
  return {
    query({ periodDays, signal }) {
      const to = new Date();
      const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
      from.setUTCDate(from.getUTCDate() - (periodDays - 1));
      return usage.querySavings({ from, to, signal });
    },
  };
}

export function createSessionUsage(sessions: SessionsService): NonNullable<PowerlineRuntimeOptions['additionalSessionUsageHost']> {
  let totals: SessionUsageTotals = emptyTotals();
  let active: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let dirty = false;
  const listeners = new Set<() => void>();
  const refresh = (): Promise<void> => {
    dirty = true;
    if (active) return active;
    controller ??= new AbortController();
    const signal = controller.signal;
    active = (async () => {
      do {
        dirty = false;
        const next = emptyTotals();
        let cursor: string | undefined;
        do {
          const page = await sessions.executions({ includeDescendants: true, signal, ...(cursor ? { cursor } : {}) });
          for (const execution of page.items) {
            if (!execution.usage) continue;
            const usage = execution.usage;
            next.input += usage.input; next.output += usage.output;
            next.cacheRead += usage.cacheRead; next.cacheWrite += usage.cacheWrite;
            next.cost += usage.cost;
          }
          cursor = page.nextCursor;
        } while (cursor);
        if (!signal.aborted) { totals = next; for (const listener of listeners) listener(); }
      } while (dirty && !signal.aborted);
    })().catch(() => {}).finally(() => { active = undefined; });
    return active;
  };
  return {
    getUsage: () => totals,
    settle: async () => { await active; },
    subscribe(listener) {
      listeners.add(listener);
      const unsubscribe = sessions.subscribe(event => { if (event.kind === 'execution') void refresh(); });
      void refresh();
      return () => { unsubscribe(); listeners.delete(listener); controller?.abort(); controller = undefined; };
    },
  };
}

function emptyTotals(): SessionUsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}
