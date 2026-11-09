import { createHash } from 'node:crypto';
import type { ExtensionContext, UiDocument } from '@felan-ai/agent-core';
import type { Component } from '@earendil-works/pi-tui';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import type { SavingsBucket } from '../src/providers/savings.js';
import { createSavingsDashboard, savingsDashboardMarkdown } from '../src/savings/dashboard.js';
import { SAVINGS_DASHBOARD_HINT, presentSavingsDocument } from '../src/tui/renderers/savings.js';
import { SavingsPanel } from '../src/tui/renderers/savings/panel.js';

const NOW = new Date('2026-11-09T10:00:00.000Z');
const CURRENT = '01a1bfb3-4375-7364-b6ac-b4a5cc04e760';
const OTHER = '01a1249a-0000-7000-8000-000000000001';
const key = (cwd: string) => createHash('sha256').update(cwd).digest('hex');

function bucket(overrides: Partial<SavingsBucket> & { saved?: number }): SavingsBucket {
  const { saved = 1, ...rest } = overrides;
  return {
    day: '2026-11-09', sessionId: CURRENT, projectKey: key('/work/felan'), producerId: '@felan-ai/ext-rtk-optimizer', category: 'output-optimization',
    operation: 'post-tool-compaction', basis: { kind: 'estimated-baseline', method: 'utf8-bytes/4-ceil-v1' }, calls: 2,
    baseline: { costUsd: saved + 1, tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }, priceSource: 'model-catalog' },
    actual: { costUsd: 1, tokens: { input: 40, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }, priceSource: 'model-catalog' },
    ...rest,
  };
}

const { dashboard, data } = createSavingsDashboard({
  buckets: [
    bucket({ saved: 3 }),
    bucket({ saved: 9, day: '2026-10-20', producerId: '@felan-ai/ext-prewalk', category: 'model-routing', operation: 'implementation-turn',
      basis: { kind: 'estimated-baseline', method: 'planner-two-thirds-usage-v1' }, sessionId: OTHER, projectKey: key('/work/site\u001b[31m-red') }),
    bucket({ saved: -0.5, day: '2026-11-08', producerId: '@felan-ai/ext-output-style', operation: 'concise-response' }),
  ],
  diagnostics: [], now: NOW, currentSessionId: CURRENT, currentProjectKey: key('/work/felan'),
  sessions: new Map([[CURRENT, { title: 'Savings dashboard', cwd: '/work/felan' }], [OTHER, { title: 'Landing page', cwd: '/work/site\u001b[31m-red' }]]),
});

function documentFor(overrides: Partial<UiDocument> = {}): UiDocument {
  return {
    id: 'savings-dashboard', kind: 'document', revision: 4, title: 'Estimated savings', fallback: 'Estimated savings',
    markdown: savingsDashboardMarkdown(dashboard), ...(data ? { data } : {}), hint: SAVINGS_DASHBOARD_HINT,
    actions: [
      { id: 'refresh', label: 'Refresh', target: 'element', outcome: 'submit' },
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
  return { ui: { custom } as unknown as Pick<ExtensionContext['ui'], 'custom'>, custom, component: () => component };
}

const text = (h: ReturnType<typeof harness>, width = 100) => h.component().render(width).join('\n');
const present = (h: ReturnType<typeof harness>, document = documentFor(), signal = new AbortController().signal) =>
  presentSavingsDocument(document, h.ui, signal);
const keys = (h: ReturnType<typeof harness>, ...values: string[]) => { for (const value of values) h.component().handleInput?.(value); };

describe('savings dashboard panel', () => {
  it('opens on the initial range and renders every tab', () => {
    const h = harness();
    void present(h);
    expect(text(h)).toContain('Felan Code Savings  Last 30 days · $11.50 saved · 6 decisions · 2 sessions');
    expect(text(h)).toContain('Measurements retained since 2026-10-20.');
    expect(text(h)).toContain('Range Today · 7 days · [30 days] · 90 days · All time');
    expect(text(h)).toContain('This session $2.50 · 4 decisions   This project (felan) $2.50 · 4 decisions');
    expect(text(h)).toContain('Decisions 6   180 fewer tokens');
    expect(text(h)).toContain('Output optimization');
    expect(text(h)).toContain('Savings per day');
    keys(h, '2');
    expect(text(h)).toContain('Prewalk');
    expect(text(h)).toContain('implementation-turn · estimated · planner');
    keys(h, '3');
    expect(text(h)).toContain('2 sessions with savings · ● this session');
    expect(text(h)).toMatch(/› {2}Landing page/u);
    expect(text(h)).toMatch(/ ● Savings dashboard/u);
    keys(h, '4');
    expect(text(h)).toMatch(/felan +● /u);
    keys(h, '\t');
    expect(text(h)).toContain('[1 Overview]');
    expect(text(h)).not.toContain('Trend');
    expect(text(h)).toContain('2026-10-11 → 2026-11-09');
    keys(h, '5');
    expect(text(h)).toContain('[1 Overview]');
  });

  it('switches ranges on the client without submitting an action', async () => {
    const h = harness();
    const result = present(h);
    keys(h, 'r');
    expect(text(h)).toContain('Felan Code Savings  Last 90 days · $11.50 saved');
    keys(h, 'r');
    expect(text(h)).toContain('All time');
    expect(text(h)).toContain('Savings per month');
    expect(text(h)).toContain('2026-10 → 2026-11');
    keys(h, 'r');
    expect(text(h)).toContain('Today (UTC) · $3.00 saved · 2 decisions · 1 session');
    keys(h, 'r');
    expect(text(h)).toContain('Last 7 days · $2.50 saved');
    expect(text(h)).toContain('-$0.50');
    expect(h.custom).toHaveBeenCalledOnce();
    keys(h, '\x1b');
    await expect(result).resolves.toEqual({ elementId: 'savings-dashboard', revision: 4, actionId: 'close', outcome: 'cancel', values: {} });
  });

  it('opens a session breakdown with Enter and returns with Escape', async () => {
    const h = harness();
    const result = present(h);
    keys(h, '3', '\x1b[B', '\r');
    expect(text(h)).toContain('Savings dashboard');
    expect(text(h)).toContain(`last measured 2026-11-09 · ${CURRENT}`);
    expect(text(h)).toContain('All-time savings $2.50 · 4 decisions · 120 fewer tokens');
    expect(text(h)).toContain(`felan · last measured 2026-11-09`);
    expect(text(h)).toContain('Output style');
    expect(text(h)).toContain('Esc back');
    keys(h, '\x1b');
    expect(text(h)).toContain('2 sessions with savings');
    keys(h, '\x1b');
    await expect(result).resolves.toMatchObject({ actionId: 'close' });
  });

  it('submits refresh with the exact revision and keeps panel state for the next revision', async () => {
    const h = harness();
    const result = present(h, documentFor({ id: 'savings-refresh' }));
    keys(h, '4', 'r', 'R');
    await expect(result).resolves.toEqual({ elementId: 'savings-refresh', revision: 4, actionId: 'refresh', outcome: 'submit', values: {} });
    const next = harness();
    void present(next, documentFor({ id: 'savings-refresh', revision: 5 }));
    expect(text(next)).toContain('Last 90 days');
    expect(text(next)).toContain('[4 Projects]');
  });

  it('ignores undeclared actions and dismisses without a close action', async () => {
    const h = harness();
    const result = present(h, documentFor({ actions: [] }));
    keys(h, 'R', '\x1b');
    await expect(result).resolves.toBeUndefined();
  });

  it('keeps every line within the terminal width and strips terminal sequences', () => {
    for (const width of [40, 80, 150]) {
      for (const tab of ['1', '2', '3', '4']) {
        const h = harness();
        void present(h, documentFor({ id: `width-${width}-${tab}` }));
        keys(h, tab);
        for (const line of h.component().render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
    const h = harness();
    void present(h, documentFor({ id: 'sanitized' }));
    keys(h, '4');
    expect(text(h)).toContain('site');
    expect(text(h)).not.toContain('\u001b[31m');
  });

  it('keeps the selected session visible while moving through a long list', () => {
    const many = createSavingsDashboard({
      buckets: Array.from({ length: 60 }, (_, index) => bucket({ sessionId: `01a00000-0000-7000-8000-${String(index).padStart(12, '0')}`, saved: 60 - index })),
      diagnostics: [], now: NOW, currentSessionId: CURRENT, currentProjectKey: key('/work/felan'), sessions: new Map(),
    });
    const h = harness(20);
    void present(h, documentFor({ id: 'long', data: many.data!, markdown: savingsDashboardMarkdown(many.dashboard) }));
    keys(h, '3');
    for (let step = 0; step < 40; step++) keys(h, '\x1b[B');
    expect(text(h)).toMatch(/› {2}Session 01a00000 .* \$20\.00/u);
  });

  it('reuses rendered bodies while scrolling', () => {
    const overview = vi.spyOn(SavingsPanel.prototype as unknown as { overview: () => string[] }, 'overview');
    const h = harness(12);
    void present(h, documentFor({ id: 'memo' }));
    text(h);
    for (let step = 0; step < 4; step++) { keys(h, '\x1b[B'); text(h); }
    expect(overview).toHaveBeenCalledOnce();
    keys(h, 'r');
    text(h);
    expect(overview).toHaveBeenCalledTimes(2);
    overview.mockRestore();
  });

  it('falls back to Markdown when the payload is missing or invalid', () => {
    const h = harness();
    void present(h, documentFor({ id: 'fallback', data: { dashboard: '{"broken":true}' } }));
    expect(text(h)).toContain('Estimated savings — Last 30 days');
    expect(text(h)).toContain('Esc close');
  });

  it('cancels promptly when the presentation is aborted', async () => {
    const h = harness();
    const controller = new AbortController();
    const pending = present(h, documentFor({ id: 'aborted' }), controller.signal);
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
    await expect(present(h, documentFor({ id: 'aborted' }), controller.signal)).resolves.toBeUndefined();
    expect(h.custom).toHaveBeenCalledOnce();
  });
});
