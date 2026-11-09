import { createHash } from 'node:crypto';
import type { AgentRuntime } from '@felan-ai/agent-core';
import { describe, expect, it } from 'vitest';
import { SavingsService, type SavingsBucket } from '../src/providers/savings.js';
import { createSavingsDashboard, savingsDashboardMarkdown, type SavingsDashboardInput } from '../src/savings/dashboard.js';
import {
  SAVINGS_DASHBOARD_BYTES, encodeSavingsDashboard, formatSavingsTokenImpact, formatSavingsTokens, formatSavingsUsd, parseSavingsDashboard, readSavingsDashboard,
  type SavingsDashboard,
} from '../src/savings/data.js';

const NOW = new Date('2026-11-09T10:00:00.000Z');
const CURRENT = '01a1bfb3-4375-7364-b6ac-b4a5cc04e760';
const OTHER = '01a1249a-0000-7000-8000-000000000001';
const UNLISTED = '01a0aaaa-0000-7000-8000-000000000002';
const key = (cwd: string) => createHash('sha256').update(cwd).digest('hex');
const HERE = key('/work/felan');
const THERE = key('/work/site');

function bucket(overrides: Partial<SavingsBucket> & { saved?: number; tokens?: [number, number] }): SavingsBucket {
  const { saved = 1, tokens = [100, 40], ...rest } = overrides;
  return {
    day: '2026-11-09', sessionId: CURRENT, projectKey: HERE, producerId: '@felan-ai/ext-rtk-optimizer', category: 'output-optimization',
    operation: 'post-tool-compaction', basis: { kind: 'estimated-baseline', method: 'utf8-bytes/4-ceil-v1' }, calls: 2,
    baseline: { costUsd: saved + 1, tokens: { input: tokens[0], output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }, priceSource: 'model-catalog' },
    actual: { costUsd: 1, tokens: { input: tokens[1], output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }, priceSource: 'model-catalog' },
    ...rest,
  };
}

function input(buckets: readonly SavingsBucket[], overrides: Partial<SavingsDashboardInput> = {}): SavingsDashboardInput {
  return {
    buckets, diagnostics: [], now: NOW, currentSessionId: CURRENT, currentProjectKey: HERE,
    sessions: new Map([[CURRENT, { title: 'Savings dashboard', cwd: '/work/felan' }], [OTHER, { title: 'Landing page', cwd: '/work/site' }]]),
    ...overrides,
  };
}

const range = (dashboard: SavingsDashboard, id: string) => dashboard.ranges.find(view => view.id === id)!;

describe('savings dashboard', () => {
  it('bounds ranges by inclusive UTC days and keeps all-time totals', () => {
    const { dashboard } = createSavingsDashboard(input([
      bucket({ day: '2026-11-09', saved: 1 }),
      bucket({ day: '2026-11-03', saved: 2 }),
      bucket({ day: '2026-11-02', saved: 4 }),
      bucket({ day: '2026-08-12', saved: 8 }),
      bucket({ day: '2026-08-11', saved: 16 }),
    ]));
    expect(dashboard.ranges.map(view => [view.id, view.from, view.to, view.totals.savedUsd])).toEqual([
      ['today', '2026-11-09', '2026-11-09', 1],
      ['7d', '2026-11-03', '2026-11-09', 3],
      ['30d', '2026-10-11', '2026-11-09', 7],
      ['90d', '2026-08-12', '2026-11-09', 15],
      ['all', undefined, '2026-11-09', 31],
    ]);
    expect(range(dashboard, 'all').totals).toEqual({ savedUsd: 31, baselineUsd: 36, actualUsd: 5, decisions: 10, savedTokens: 300 });
    expect(dashboard).toMatchObject({ firstDay: '2026-08-11', lastDay: '2026-11-09', initialRange: '30d', initialTab: 'overview' });
  });

  it('groups by category, extension, operation, session and project', () => {
    const { dashboard } = createSavingsDashboard(input([
      bucket({ saved: 3 }),
      bucket({ saved: 1, operation: 'rtk-command-output', basis: { kind: 'observed-comparison', method: 'rtk-tracking-byte4-v1' } }),
      bucket({ saved: 5, producerId: '@felan-ai/ext-prewalk', category: 'model-routing', operation: 'implementation-turn', sessionId: OTHER, projectKey: THERE }),
      bucket({ saved: 2, producerId: 'third-party/ext', category: 'other', operation: undefined, sessionId: UNLISTED, projectKey: key('/gone') }),
    ]));
    const view = range(dashboard, '30d');
    expect(view.categories.map(row => [row.category, row.savedUsd])).toEqual([['output-optimization', 4], ['model-routing', 5], ['other', 2]]);
    const extensions = view.extensions.map(row => ({ ...dashboard.extensions[row.extension], saved: row.savedUsd, operations: row.operations.map(item => [item.operation, item.basis, item.savedUsd]) }));
    expect(extensions).toEqual([
      { id: '@felan-ai/ext-prewalk', label: 'Prewalk', category: 'model-routing', saved: 5, operations: [['implementation-turn', 'estimated-baseline', 5]] },
      { id: '@felan-ai/ext-rtk-optimizer', label: 'RTK optimizer', category: 'output-optimization', saved: 4,
        operations: [['post-tool-compaction', 'estimated-baseline', 3], ['rtk-command-output', 'observed-comparison', 1]] },
      { id: 'third-party/ext', label: 'third-party/ext', category: 'other', saved: 2, operations: [['unspecified', 'estimated-baseline', 2]] },
    ]);
    const sessions = view.sessions.map(row => {
      const session = dashboard.sessions[row.session]!;
      return [session.title, dashboard.projects[session.project]!.label, row.savedUsd];
    });
    expect(sessions).toEqual([['Landing page', 'site', 5], ['Savings dashboard', 'felan', 4], ['Session 01a0aaaa', `Project ${key('/gone').slice(0, 8)}`, 2]]);
    expect(dashboard.sessions[dashboard.currentSession!]!.title).toBe('Savings dashboard');
    expect(dashboard.projects[dashboard.currentProject!]!.label).toBe('felan');
    expect(dashboard.sessions[dashboard.currentSession!]!.extensions.map(row => [dashboard.extensions[row.extension]!.label, row.savedUsd])).toEqual([['RTK optimizer', 4]]);
    expect(view.projects.map(row => [dashboard.projects[row.project]!.label, row.sessions, row.savedUsd])).toEqual([['site', 1, 5], ['felan', 1, 4], [`Project ${key('/gone').slice(0, 8)}`, 1, 2]]);
    expect(view.currentSession.savedUsd).toBe(4);
    expect(view.currentProject.savedUsd).toBe(4);
  });

  it('keeps unpriced decisions out of USD totals and preserves added cost', () => {
    const unpriced = bucket({ calls: 3, tokens: [500, 100] });
    const { costUsd: _, ...unpricedBaseline } = unpriced.baseline;
    const { dashboard } = createSavingsDashboard(input([
      { ...unpriced, baseline: { ...unpricedBaseline, priceSource: 'unavailable' } },
      bucket({ saved: -0.25, tokens: [100, 300] }),
    ]));
    const view = range(dashboard, 'today');
    expect(view.unpriced).toEqual({ decisions: 3, savedTokens: 400 });
    expect(view.totals).toEqual({ savedUsd: -0.25, baselineUsd: 0.75, actualUsd: 1, decisions: 2, savedTokens: -200 });
    expect(formatSavingsUsd(view.totals.savedUsd)).toBe('-$0.25');
    expect(savingsDashboardMarkdown(dashboard)).toContain('3 decisions without a price are excluded from USD totals (400 fewer tokens).');
    expect(savingsDashboardMarkdown(dashboard)).toContain('Token impact: 200 more tokens');
  });

  it('fills daily trends for bounded ranges and monthly trends for all time', () => {
    const { dashboard } = createSavingsDashboard(input([bucket({ day: '2026-11-07', saved: 2 }), bucket({ day: '2026-09-30', saved: 1 })]));
    expect(range(dashboard, '7d').trend).toMatchObject({ granularity: 'day' });
    expect(range(dashboard, '7d').trend.points.map(point => [point.period, point.savedUsd])).toEqual([
      ['2026-11-03', 0], ['2026-11-04', 0], ['2026-11-05', 0], ['2026-11-06', 0], ['2026-11-07', 2], ['2026-11-08', 0], ['2026-11-09', 0],
    ]);
    expect(range(dashboard, 'all').trend.points.map(point => [point.period, point.savedUsd])).toEqual([['2026-09', 1], ['2026-10', 0], ['2026-11', 2]]);
  });

  it('labels the current project from its folder when its session is not listed yet', () => {
    const draft = key('/work/new-app');
    const { dashboard } = createSavingsDashboard(input([bucket({ projectKey: draft })], { currentProjectKey: draft, currentProjectCwd: '/work/new-app', sessions: new Map() }));
    expect(dashboard.projects[dashboard.currentProject!]!.label).toBe('new-app');
    expect(dashboard.sessions[dashboard.currentSession!]!.title).toBe('Session 01a1bfb3');
  });

  it('lists the current session even before it has measurements', () => {
    const { dashboard } = createSavingsDashboard(input([bucket({ sessionId: OTHER, projectKey: THERE })]));
    expect(dashboard.sessions[dashboard.currentSession!]).toMatchObject({ title: 'Savings dashboard', lastDay: '2026-11-09', extensions: [] });
    expect(range(dashboard, 'today').currentSession).toEqual({ savedUsd: 0, baselineUsd: 0, actualUsd: 0, decisions: 0, savedTokens: 0 });
  });

  it('round-trips document data and rejects malformed dashboards', () => {
    const { dashboard, data } = createSavingsDashboard(input([bucket({}), bucket({ sessionId: OTHER, projectKey: THERE })], {
      initialRange: 'all', initialTab: 'sessions', diagnostics: ['1 savings writes failed'],
    }));
    expect(readSavingsDashboard(data)).toEqual(dashboard);
    const encoded = JSON.parse(data!.dashboard as string) as Record<string, unknown>;
    const broken = (patch: (value: Record<string, any>) => void) => {
      const copy = structuredClone(encoded) as Record<string, any>;
      patch(copy);
      return () => parseSavingsDashboard(copy);
    };
    expect(broken(value => { value.extra = true; })).toThrow('Invalid savings dashboard data.');
    expect(broken(value => { value.ranges[2].sessions[0].session = 99; })).toThrow('Invalid savings dashboard data.');
    expect(broken(value => { value.ranges.reverse(); })).toThrow('Invalid savings dashboard data.');
    expect(broken(value => { value.sessions[0].title = 'bad\u0007title'; })).toThrow('Invalid savings dashboard data.');
    expect(broken(value => { value.ranges[0].totals.decisions = -1; })).toThrow('Invalid savings dashboard data.');
    expect(broken(value => { value.ranges[4].from = '2026-01-01'; })).toThrow('Invalid savings dashboard data.');
    expect(() => readSavingsDashboard({ dashboard: '{' })).toThrow('Invalid savings dashboard data.');
  });

  it('drops the smallest session rows when the document exceeds its budget', () => {
    const title = 'x'.repeat(240);
    const sessions = new Map<string, { title: string; cwd: string }>();
    const buckets: SavingsBucket[] = [];
    for (let index = 0; index < 2_500; index++) {
      const id = `01a00000-0000-7000-8000-${String(index).padStart(12, '0')}`;
      sessions.set(id, { title: `${title}${index}`, cwd: '/work/felan' });
      buckets.push(bucket({ sessionId: id, saved: index / 100 }));
    }
    const { dashboard, data } = createSavingsDashboard(input(buckets, { sessions }));
    expect(data).toBeDefined();
    expect((data!.dashboard as string).length).toBeLessThanOrEqual(SAVINGS_DASHBOARD_BYTES);
    const today = range(dashboard, 'today');
    expect(today.omittedSessions).toBeGreaterThan(0);
    expect(today.sessions.length + today.omittedSessions).toBe(2_500);
    expect(today.totals.decisions).toBe(5_000);
    expect(dashboard.sessions[today.sessions.at(-1)!.session]!.title.endsWith(String(today.omittedSessions))).toBe(true);
    expect(savingsDashboardMarkdown(dashboard)).toContain(`${today.omittedSessions} smaller sessions are not listed.`);
  });

  it('renders Markdown for clients without the dashboard renderer', () => {
    const { dashboard } = createSavingsDashboard(input([bucket({ saved: 1234.5 })], { diagnostics: ['Savings storage is incomplete'] }));
    const markdown = savingsDashboardMarkdown(dashboard);
    expect(markdown).toContain('# Estimated savings — Last 30 days');
    expect(markdown).toContain('Estimated API-equivalent cost avoided: **$1,234.50**');
    expect(markdown).toContain('| RTK optimizer | Output optimization | 2 | 60 | $1,234.50 |');
    expect(markdown).toContain('| Savings dashboard | felan | 2 | $1,234.50 |');
    expect(markdown).toContain('Warning: Savings storage is incomplete');
  });

  it('encodes nothing when a dashboard cannot fit even without session rows', () => {
    const { dashboard } = createSavingsDashboard(input([bucket({})]));
    const oversized = { ...dashboard, diagnostics: Array.from({ length: 3_000 }, () => 'd'.repeat(200)) };
    expect(encodeSavingsDashboard(oversized)).toBeUndefined();
  });

  it('formats signed USD and token amounts', () => {
    expect([formatSavingsUsd(0), formatSavingsUsd(-0.004), formatSavingsUsd(2350.834), formatSavingsUsd(-12)]).toEqual(['$0.00', '$0.00', '$2,350.83', '-$12.00']);
    expect([formatSavingsTokens(950), formatSavingsTokens(1_500), formatSavingsTokens(-24_000), formatSavingsTokens(3_200_000)]).toEqual(['950', '1.5K', '-24K', '3.2M']);
    expect([formatSavingsTokenImpact(138_000), formatSavingsTokenImpact(-1_000_000_000), formatSavingsTokenImpact(0)]).toEqual(['138K fewer tokens', '1B more tokens', 'no token change']);
  });
});

describe('savings store listing', () => {
  it('reports when the snapshot listing reaches its bound instead of silently undercounting', async () => {
    const writer = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const files = Array.from({ length: 10_001 }, (_, index) => `writers/${writer(index)}/1.json`);
    const storage = {
      listFiles: async () => files,
      readFile: async (path: string) => new TextEncoder().encode(JSON.stringify({
        version: 1, writerId: /writers\/([^/]+)\//u.exec(path)![1], sequence: 1, updatedAt: NOW.toISOString(), buckets: [],
      })),
    };
    const runtime = { storage: () => storage } as unknown as AgentRuntime;
    const report = await new SavingsService({ runtime, rootSessionId: 'cli', projectKey: 'x' }).query({ scope: 'all' });
    expect(report.diagnostics).toEqual(['Savings storage holds more than 10000 snapshot files; totals may be incomplete']);
  });
});
