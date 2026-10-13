import type { ExtensionUi, UiElementHandle, UiInteractiveElement } from '@felan-ai/agent-core';
import type { PowerlinePresentationHost, PowerlineRuntimeSnapshot } from './runtime.js';
import { parsePowerlineData, type PowerlineData } from './data.js';

export const POWERLINE_GENERIC_HINT = Object.freeze({ id: 'felan.powerline', version: '2.0.0' });

type Status = Parameters<ExtensionUi['status']>[0];
type View = Extract<UiInteractiveElement, { kind: 'view' }>;

export function createGenericPowerlinePresentation(ui: ExtensionUi): PowerlinePresentationHost {
  const lifetime = new AbortController();
  const handles = new Map<string, UiElementHandle>();
  const revisions = new Map<string, number>();
  const statuses = new Set<string>();
  let pending: { data: PowerlineData; snapshot: PowerlineRuntimeSnapshot | undefined } | undefined;
  let work: Promise<void> | undefined;
  let cleanup: Promise<void> | undefined;
  let stopped = false;
  let failure: Error | undefined;

  async function publishViews(data: PowerlineData): Promise<void> {
    const items: View['items'] = [
      ...(['style', 'charset', 'autoWrap', 'padding'] as const).map(key => ({
        id: `display-${key}`, values: { line: 0, segment: `display.${key}`, text: String(data[key]), alignment: '', color: '' },
        fallback: `Display ${key}`,
      })),
      { id: 'display-lines', values: { line: 0, segment: 'display.lines', text: String(data.lines.length), alignment: '', color: '' }, fallback: 'Display line count' },
      ...data.lines.flatMap((line, lineIndex) => line.map((segment, index) => ({
        id: `line-${lineIndex}-segment-${index}`,
        values: { line: lineIndex + 1, segment: segment.name, text: segment.text, alignment: segment.align, color: segment.colorKey },
        fallback: `Line ${lineIndex + 1}: ${segment.name}`,
      }))),
    ];
    const ids = new Set<string>();
    for (let offset = 0; offset < items.length && !stopped; offset += 100) {
      const id = `powerline-data-${offset / 100}`;
      ids.add(id);
      const previous = handles.get(id);
      const revision = (revisions.get(id) ?? 0) + 1;
      const element: View = {
        id, kind: 'view', revision, title: 'Powerline', hint: POWERLINE_GENERIC_HINT,
        fields: [
          { id: 'line', label: 'Line', valueKind: 'number' },
          { id: 'segment', label: 'Segment', valueKind: 'text' },
          { id: 'text', label: 'Value', valueKind: 'text' },
          { id: 'alignment', label: 'Alignment', valueKind: 'text' },
          { id: 'color', label: 'Color role', valueKind: 'text' },
        ],
        items: items.slice(offset, offset + 100), actions: [],
        fallback: `Powerline data: rows ${offset + 1}–${Math.min(offset + 100, items.length)} of ${items.length}`,
      };
      if (previous) {
        await previous.update(element);
      } else {
        const handle = await ui.present(element, { signal: lifetime.signal });
        handles.set(id, handle);
      }
      revisions.set(id, revision);
    }
    if (stopped) return;
    for (const [id, entry] of handles) {
      if (ids.has(id)) continue;
      await entry.close();
      handles.delete(id);
    }
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
        ...[...handles].map(async ([id, entry]) => { await entry.close(); handles.delete(id); }),
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
