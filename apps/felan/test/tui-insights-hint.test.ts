import type { ExtensionContext, UiDocument } from '@felan-ai/agent-core';
import type { Component } from '@earendil-works/pi-tui';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import {
  buildInsightsDashboard, encodeInsightsDashboard, generateDashboardMarkdown, INSIGHTS_DOCUMENT_HINT, parseSessionTranscript,
  type InsightsLoadedSession,
} from '@felan-ai/ext-insights';
import { presentInsightsDocument } from '../src/tui/renderers/insights.js';

function session(id: string, project: string, timestamp: string, user = 'hello'): InsightsLoadedSession {
  const transcript = [
    JSON.stringify({ type: 'session', id, cwd: `/workspace/${project}`, timestamp }),
    JSON.stringify({ type: 'message', timestamp, message: { role: 'user', content: [{ type: 'text', text: user }] } }),
    JSON.stringify({ type: 'message', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: 'model-a', provider: 'p', usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.02 } } } }),
  ].join('\n');
  return { rootId: id, session: parseSessionTranscript(transcript, id)! };
}

const generatedAt = new Date('2026-01-10T12:00:00Z');
const loaded = [
  session('a', 'alpha', '2026-01-05T10:00:00Z'),
  session('b', 'beta\u001b[31m-red', '2026-01-08T10:00:00Z', 'damn it'),
  session('c', 'gamma', '2026-01-09T10:00:00Z'),
];
const dashboard = buildInsightsDashboard({ path: '/reports/felan-insights.html', generatedAt, initialRange: '30d', loaded }, { range: '30d', query: '', page: 0 });
const rangeOptions = ['7d', '30d', '90d', 'all'].map(id => ({ id, label: id }));

function documentFor(overrides: Partial<UiDocument> = {}): UiDocument {
  return {
    id: 'insights-report', kind: 'document', revision: 3, title: 'Session insights', fallback: 'Session insights',
    markdown: generateDashboardMarkdown(dashboard), data: encodeInsightsDashboard(dashboard), hint: INSIGHTS_DOCUMENT_HINT,
    actions: [
      { id: 'range', label: 'Range', target: 'element', outcome: 'submit', input: { fields: [{ id: 'range', kind: 'enum', label: 'Range', required: true, options: rangeOptions }], defaults: { range: '30d' } } },
      { id: 'sessions-search', label: 'Search sessions', target: 'element', outcome: 'submit', input: { fields: [{ id: 'query', kind: 'string', label: 'Search', required: false, maxLength: 1024 }], defaults: { query: '' } } },
      { id: 'sessions-next', label: 'Next sessions', target: 'element', outcome: 'submit' },
      { id: 'open-browser', label: 'Open in browser', target: 'element', outcome: 'submit' },
      { id: 'close', label: 'Close', target: 'element', outcome: 'cancel' },
    ],
    ...overrides,
  };
}

function harness(rows = 40) {
  let component!: Component;
  const custom = vi.fn<ExtensionContext['ui']['custom']>(factory => new Promise(resolve => {
    const plain = (text: string) => text;
    component = factory({ terminal: { rows }, requestRender: vi.fn() } as never,
      { fg: (_name: string, text: string) => text, bold: plain, italic: plain, strikethrough: plain, underline: plain } as never,
      {} as never, resolve) as Component;
  }));
  const input = vi.fn(async () => 'alpha');
  return { ui: { custom, input } as unknown as Pick<ExtensionContext['ui'], 'custom'> & { input: typeof input }, custom, input, component: () => component };
}

const text = (h: ReturnType<typeof harness>, width = 80) => h.component().render(width).join('\n');

describe('insights dashboard hint', () => {
  it('renders the overview with tabs and switches tabs by number and Tab', () => {
    const h = harness();
    void presentInsightsDocument(documentFor(), h.ui, new AbortController().signal);
    expect(text(h)).toContain('Sessions 3');
    expect(text(h)).toContain('Activity calendar');
    h.component().handleInput?.('2');
    expect(text(h)).toContain('Efficiency');
    h.component().handleInput?.('\t');
    expect(text(h)).toContain('Sorted by messages');
    h.component().handleInput?.('s');
    expect(text(h)).toContain('Sorted by sessions');
    h.component().handleInput?.('4');
    expect(text(h)).toContain('Start');
  });

  it('submits only declared actions with the exact revision and values', async () => {
    const range = harness();
    const rangeResult = presentInsightsDocument(documentFor(), range.ui, new AbortController().signal);
    range.component().handleInput?.('r');
    await expect(rangeResult).resolves.toEqual({ elementId: 'insights-report', revision: 3, actionId: 'range', outcome: 'submit', values: { range: '90d' } });

    const open = harness();
    const openResult = presentInsightsDocument(documentFor(), open.ui, new AbortController().signal);
    open.component().handleInput?.('o');
    await expect(openResult).resolves.toEqual({ elementId: 'insights-report', revision: 3, actionId: 'open-browser', outcome: 'submit', values: {} });

    const undeclared = harness();
    const pending = presentInsightsDocument(documentFor({ actions: [{ id: 'close', label: 'Close', target: 'element', outcome: 'cancel' }] }), undeclared.ui, new AbortController().signal);
    undeclared.component().handleInput?.('o');
    undeclared.component().handleInput?.('4');
    undeclared.component().handleInput?.('\x1b[C');
    undeclared.component().handleInput?.('\x1b');
    await expect(pending).resolves.toMatchObject({ actionId: 'close', outcome: 'cancel' });
  });

  it('collects a search query through the input prompt and then submits the declared search action', async () => {
    const h = harness();
    const result = presentInsightsDocument(documentFor(), h.ui, new AbortController().signal);
    h.component().handleInput?.('/');
    await expect(result).resolves.toEqual({ elementId: 'insights-report', revision: 3, actionId: 'sessions-search', outcome: 'submit', values: { query: 'alpha' } });
    expect(h.input).toHaveBeenCalledOnce();
  });

  it('pages sessions with the declared next action on the Sessions tab only', async () => {
    const h = harness();
    const result = presentInsightsDocument(documentFor(), h.ui, new AbortController().signal);
    h.component().handleInput?.('\x1b[C');
    h.component().handleInput?.('4');
    h.component().handleInput?.('\x1b[C');
    await expect(result).resolves.toMatchObject({ actionId: 'sessions-next', values: {} });
  });

  it('keeps every line within the terminal width and sanitizes hostile names', () => {
    for (const width of [40, 80, 160]) {
      for (const tab of ['1', '2', '3', '4', '5']) {
        const h = harness();
        void presentInsightsDocument(documentFor(), h.ui, new AbortController().signal);
        h.component().handleInput?.(tab);
        for (const line of h.component().render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
    const h = harness();
    void presentInsightsDocument(documentFor(), h.ui, new AbortController().signal);
    h.component().handleInput?.('3');
    expect(text(h)).toContain('beta');
    expect(text(h)).not.toContain('\u001b[31m');
  });

  it('falls back to the Markdown view when the payload is invalid', () => {
    const h = harness();
    void presentInsightsDocument(documentFor({ data: { dashboard: '{"broken": true}' } }), h.ui, new AbortController().signal);
    expect(text(h)).toContain('Felan Code Insights Report');
  });

  it('dismisses through Escape and cancels promptly on abort', async () => {
    const h = harness(); const result = presentInsightsDocument(documentFor({ actions: [] }), h.ui, new AbortController().signal);
    h.component().handleInput?.('\x1b');
    await expect(result).resolves.toBeUndefined();

    const aborted = harness(); const controller = new AbortController();
    const pending = presentInsightsDocument(documentFor(), aborted.ui, controller.signal);
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
    await expect(presentInsightsDocument(documentFor(), aborted.ui, controller.signal)).resolves.toBeUndefined();
    expect(aborted.custom).toHaveBeenCalledOnce();
  });
});
