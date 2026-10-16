import { describe, expect, it } from 'vitest';
import { buildInsightsDashboard, insightsRangeOptions, sessionsForRange } from '../src/dashboard.js';
import { encodeInsightsDashboard, INSIGHTS_SESSIONS_PAGE_SIZE, parseInsightsDashboard, readInsightsDashboard, insightsText, insightsRangeLabel } from '../src/data.js';
import { generateDashboardMarkdown } from '../src/markdown.js';
import { computeAnalytics } from '../src/analytics.js';
import { parseSessionTranscript } from '../src/parser.js';
import type { InsightsLoadedSession, InsightsReport } from '../src/contracts.js';

const GENERATED = new Date('2026-01-10T12:00:00Z');

function transcript(id: string, project: string, timestamp: string, text = 'hello'): string {
  return [
    JSON.stringify({ type: 'session', id, cwd: `/workspace/${project}`, timestamp }),
    JSON.stringify({ type: 'message', timestamp, message: { role: 'user', content: [{ type: 'text', text }] } }),
    JSON.stringify({ type: 'message', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], model: 'model-a', provider: 'p', usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.01 } } } }),
  ].join('\n');
}

function loaded(id: string, project: string, timestamp: string, text?: string): InsightsLoadedSession {
  return { rootId: id, session: parseSessionTranscript(transcript(id, project, timestamp, text), id)! };
}

function report(entries: InsightsLoadedSession[]): InsightsReport {
  return { path: '/reports/felan-insights.html', generatedAt: GENERATED, initialRange: '30d', loaded: entries };
}

describe('insights dashboard contract', () => {
  it('matches computeAnalytics totals for the selected range', () => {
    const entries = [loaded('a', 'alpha', '2026-01-05T10:00:00Z'), loaded('b', 'beta', '2026-01-08T10:00:00Z'), loaded('c', 'beta', '2025-06-01T10:00:00Z')];
    const dashboard = buildInsightsDashboard(report(entries), { range: '30d', query: '', page: 0 });
    const expected = computeAnalytics(sessionsForRange(entries, '30d', GENERATED));
    expect(dashboard.totals).toMatchObject({ sessions: 2, messages: expected.totalMessages, tokens: expected.totalTokens, cost: expected.totalCost });
    expect(dashboard.loadedSessions).toBe(3);
    expect(dashboard.range).toEqual({ id: '30d', label: 'Last 30 days', from: '2025-12-11T12:00:00.000Z', to: '2026-01-10T12:00:00.000Z' });
    expect(buildInsightsDashboard(report(entries), { range: 'all', query: '', page: 0 }).totals.sessions).toBe(3);
  });

  it('recomputes the same totals from the loaded entries on every range change', () => {
    const entries = [loaded('root', 'alpha', '2026-01-05T10:00:00Z'), { rootId: 'root', session: parseSessionTranscript(transcript('agent', 'alpha', '2026-01-06T10:00:00Z'), 'agent')! }];
    const first = buildInsightsDashboard(report(entries), { range: 'all', query: '', page: 0 });
    const again = buildInsightsDashboard(report(entries), { range: 'all', query: '', page: 0 });
    expect(again.totals).toEqual(first.totals);
    expect(first.totals.sessions).toBe(1);
    expect(first.totals.messages).toBe(4);
  });

  it('round-trips through the encoded data value and rejects malformed payloads', () => {
    const dashboard = buildInsightsDashboard(report([loaded('a', 'alpha', '2026-01-05T10:00:00Z')]), { range: '7d', query: 'alp', page: 0 });
    const data = encodeInsightsDashboard(dashboard);
    expect(readInsightsDashboard(data)).toEqual(dashboard);
    expect(() => readInsightsDashboard(undefined)).toThrow('Invalid insights dashboard data.');
    expect(() => readInsightsDashboard({ dashboard: '{"generatedAt":1}' })).toThrow();
    expect(() => parseInsightsDashboard({ ...dashboard, extra: true })).toThrow();
    expect(() => parseInsightsDashboard({ ...dashboard, totals: { ...dashboard.totals, sessions: -1 } })).toThrow();
    expect(() => parseInsightsDashboard({ ...dashboard, range: { ...dashboard.range, id: '1000000000d' } })).toThrow();
    expect(() => parseInsightsDashboard({ ...dashboard, range: { ...dashboard.range, label: 'bad\u0007label' } })).toThrow();
    expect(() => parseInsightsDashboard({ ...dashboard, daily: [{ date: '2026-01-02' }] })).toThrow();
  });

  it('sanitizes hostile names and keeps Markdown free of raw HTML and links', () => {
    const hostile = '<img src=x onerror=alert(1)>[x](javascript:alert(1))|pipe\u0007`*';
    const dashboard = buildInsightsDashboard(report([loaded('a', hostile, '2026-01-05T10:00:00Z')]), { range: 'all', query: '', page: 0 });
    expect(dashboard.projects[0]!.name).not.toMatch(/[\u0000-\u001f]/u);
    const markdown = generateDashboardMarkdown(dashboard);
    expect(markdown).toContain('# Felan Code Insights Report');
    expect(markdown).not.toMatch(/<\/?[a-z]/iu);
    expect(markdown).not.toMatch(/\]\(/u);
    expect(markdown).toContain('&lt;img src=x onerror=alert\\(1\\)&gt;');
    expect(markdown).toContain('| Start | Project |');
    expect(insightsText(`a\u0000 ${'界'.repeat(200)}`, 64).length).toBeLessThan(40);
    expect(insightsRangeLabel('1d')).toBe('Last 24 hours');
  });

  it('keeps the encoded payload bounded by one session page for a large three-year history', () => {
    const entries: InsightsLoadedSession[] = [];
    for (let index = 0; index < 5000; index++) {
      const day = new Date(Date.UTC(2024, 0, 1) + (index % 1095) * 86_400_000 + 3_600_000 * (index % 20));
      entries.push(loaded(`s${index}`, `project-${index % 300}`, day.toISOString(), 'hi'));
    }
    const dashboard = buildInsightsDashboard({ ...report(entries), generatedAt: new Date('2027-01-01T00:00:00Z') }, { range: 'all', query: '', page: 0 });
    expect(dashboard.sessions.rows).toHaveLength(INSIGHTS_SESSIONS_PAGE_SIZE);
    expect(dashboard.sessions.matched).toBe(5000);
    expect(dashboard.daily.length).toBeGreaterThan(0);
    const data = encodeInsightsDashboard(dashboard);
    expect(data).toBeDefined();
    expect(new TextEncoder().encode(JSON.stringify(data)).byteLength).toBeLessThan(512 * 1024);
    expect(insightsRangeOptions('30d')).toEqual(['7d', '30d', '90d', 'all']);
  });
});
