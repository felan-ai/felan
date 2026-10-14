import type { ExtensionUi, UiElementHandle, UiInteractiveElement } from '@felan-ai/agent-core';
import type { PowerlinePresentationHost, PowerlineRuntimeSnapshot } from './runtime.js';
import { parsePowerlineData, type PowerlineData } from './data.js';

export const POWERLINE_GENERIC_HINT = Object.freeze({ id: 'felan.powerline', version: '3.0.0' });

type Status = Parameters<ExtensionUi['status']>[0];
type View = Extract<UiInteractiveElement, { kind: 'view' }>;

export function createGenericPowerlinePresentation(ui: ExtensionUi): PowerlinePresentationHost {
  const lifetime = new AbortController();
  let handle: UiElementHandle | undefined;
  let revision = 0;
  const statuses = new Set<string>();
  let pending: { data: PowerlineData; snapshot: PowerlineRuntimeSnapshot | undefined } | undefined;
  let work: Promise<void> | undefined;
  let cleanup: Promise<void> | undefined;
  let stopped = false;
  let failure: Error | undefined;

  async function publishViews(data: PowerlineData): Promise<void> {
    const items: View['items'] = data.segments.map(segment => ({
      id: segment.name, values: { segment: segment.name, data: JSON.stringify(segment.values), color: segment.colorKey },
      fallback: `${segment.name} values`,
    }));
    const element: View = {
      id: 'powerline-data', kind: 'view', revision: ++revision, title: 'Powerline', hint: POWERLINE_GENERIC_HINT,
      fields: [
        { id: 'segment', label: 'Segment', valueKind: 'text' },
        { id: 'data', label: 'Values', valueKind: 'text' },
        { id: 'color', label: 'Color role', valueKind: 'text' },
      ],
      items, actions: [], fallback: 'Powerline segment values',
    };
    if (handle) await handle.update(element);
    else handle = await ui.present(element, { signal: lifetime.signal });
  }

  async function publishStatuses(snapshot: PowerlineRuntimeSnapshot | undefined): Promise<void> {
    const values: Status[] = [];
    const add = (key: string, label: string, value: number | null | undefined, kind: 'tokens' | 'percent' | 'money') => {
      if (value === null || value === undefined || !Number.isFinite(value) || value < 0
        || kind === 'tokens' && !Number.isSafeInteger(value) || kind === 'percent' && value > 100
        || value > Number.MAX_SAFE_INTEGER) return;
      const id = `powerline-${key}`;
      values.push({ id, kind: 'status', key: id, hint: POWERLINE_GENERIC_HINT,
        value: kind === 'money' ? { kind, value, currency: 'USD' } : { kind, value },
        fallback: `${label}: ${value}${kind === 'money' ? ' USD' : kind === 'percent' ? '%' : ' tokens'}` });
    };
    if (snapshot?.session) {
      add('session-input', 'Input', snapshot.session.input, 'tokens');
      add('session-output', 'Output', snapshot.session.output, 'tokens');
      add('session-cache-read', 'Cache read', snapshot.session.cacheRead, 'tokens');
      add('session-cache-write', 'Cache write', snapshot.session.cacheWrite, 'tokens');
      add('session-cost', 'Session cost', snapshot.session.cost, 'money');
    }
    if (snapshot?.context) {
      add('context-tokens', 'Context', snapshot.context.tokens, 'tokens');
      add('context-window', 'Context window', snapshot.context.contextWindow, 'tokens');
      add('context-percent', 'Context used', snapshot.context.percent, 'percent');
    }
    const ids = new Set(values.map(value => value.id));
    for (const value of values) {
      if (stopped) return;
      statuses.add(value.id);
      await ui.status(value);
    }
    if (stopped) return;
    for (const id of statuses) {
      if (ids.has(id)) continue;
      await ui.removeStatus(id);
      statuses.delete(id);
    }
  }

  function clear(): void {
    stopped = true;
    pending = undefined;
    lifetime.abort();
    cleanup ??= (async () => {
      await work;
      const results = await Promise.allSettled([
        ...(handle ? [handle.close()] : []),
        ...[...statuses].map(async id => { await ui.removeStatus(id); statuses.delete(id); }),
      ]);
      if (results.some(result => result.status === 'rejected')) {
        const error = new Error('Powerline data cleanup failed.');
        failure = failure ? new AggregateError([failure, error], error.message) : error;
      }
    })();
  }

  function flush(): void {
    if (work || stopped) return;
    work = (async () => {
      while (pending && !stopped) {
        const next = pending;
        pending = undefined;
        await publishViews(next.data);
        if (!stopped) await publishStatuses(next.snapshot);
      }
    })().catch(() => {
      if (stopped) return;
      failure = new Error('Powerline data publication failed.');
      clear();
    }).finally(() => {
      work = undefined;
      if (pending && !stopped) flush();
    });
  }

  return {
    publish(data, snapshot) {
      if (failure) throw failure;
      if (stopped) return false;
      pending = { data: parsePowerlineData(data), snapshot: snapshot === undefined ? undefined : structuredClone(snapshot) };
      flush();
      return true;
    },
    clear,
    async settle() {
      while (work) await work;
      await cleanup;
      if (failure) throw failure;
    },
  };
}
