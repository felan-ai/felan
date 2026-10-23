import type { ExtensionContext } from '@felan-ai/agent-core';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import { getThemePalette } from '../../src/tui/renderers/powerline/colors.js';
import { DEFAULT_CONFIG, type PowerlineConfig, type SegmentName } from '../../src/tui/renderers/powerline/config.js';
import { renderFooterLine, renderStyledSegments } from '../../src/tui/renderers/powerline.js';
import { renderSegments, sanitizePlainText, type RenderedSegment } from '../../src/tui/renderers/powerline/segments.js';
import type { SubscriptionState } from '../../../../packages/ext-powerline/src/subscription.js';
import { getSymbols } from '../../src/tui/renderers/powerline/symbols.js';
import { getUsageTotals } from '../../../../packages/ext-powerline/src/usage.js';
import type { PowerlineData, SegmentValues, SessionUsageTotals } from '@felan-ai/ext-powerline/data';

const theme = {
  getFgAnsi: (_color: string) => `\x1b[38;5;42m`,
  getBgAnsi: (_color: string) => `\x1b[48;5;42m`,
};

describe('powerline rendering', () => {
  it('maps Powerline roles to the active Pi theme', () => {
    const palette = getThemePalette(theme);
    expect(palette.colors.directory.fg).toBe(theme.getFgAnsi('accent'));
    expect(palette.colors.directory.bg).toBe(theme.getBgAnsi('customMessageBg'));
    expect(palette.colors.model.fg).toBe(theme.getFgAnsi('muted'));
    expect(palette.colors.session.fg).toBe(theme.getFgAnsi('text'));
    expect(palette.colors.savings.bg).toBe(theme.getBgAnsi('customMessageBg'));
    expect(palette.colors.critical.bg).toBe(theme.getBgAnsi('toolErrorBg'));
  });

  it('renders minimal, powerline, and capsule styles with both charsets', () => {
    const segments = [segment('directory', 'one'), segment('git', 'two')];
    const expected = {
      minimal: 'one | two',
      powerline: 'one two ',
      capsule: '[one] [two]',
    } as const;

    for (const style of ['minimal', 'powerline', 'capsule'] as const) {
      const config = testConfig({ style, charset: 'text', padding: 0 });
      expect(renderStyledSegments(segments, config, getThemePalette(theme), 'none', getSymbols('text'))).toContain(expected[style]);
    }

    const unicode = testConfig({ style: 'powerline', charset: 'unicode', padding: 0 });
    expect(renderStyledSegments(segments, unicode, getThemePalette(theme), 'none', getSymbols('unicode'))).toContain('onetwo');
  });

  it('measures ANSI-colored content by visible width and truncates safely', () => {
    const config = testConfig({ style: 'powerline', charset: 'unicode', padding: 1, autoWrap: false });
    const lines = renderFooterLine(
      [segment('directory', '界界界界')],
      config,
      getThemePalette(theme),
      'truecolor',
      getSymbols('unicode'),
      7,
    );

    expect(lines[0]).toContain('\x1b[');
    expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(7);
    expect(sanitizePlainText(lines[0]!)).not.toContain('\x1b');
  });

  it('keeps every footer style foreground-only, including warning and critical segments', () => {
    const palette = getThemePalette(theme);
    const segments = [segment('directory', 'directory'), segment('git', 'warning'), segment('model', 'critical', 'right')];
    segments[1]!.colorKey = 'warning';
    segments[2]!.colorKey = 'critical';

    for (const style of ['minimal', 'powerline', 'capsule'] as const) {
      for (const charset of ['text', 'unicode'] as const) {
        for (const mode of ['ansi', 'ansi256', 'truecolor'] as const) {
          const config = testConfig({ style, charset, padding: 1 });
          const styled = renderStyledSegments(segments, config, palette, mode, getSymbols(charset));
          const aligned = renderFooterLine(segments, config, palette, mode, getSymbols(charset), 80).join('\n');
          const truncated = renderFooterLine(segments, config, palette, mode, getSymbols(charset), 8).join('\n');
          for (const output of [styled, aligned, truncated]) {
            expect(output).toContain(theme.getFgAnsi('accent'));
            expect(output).not.toMatch(/\x1b\[(?:4[0-9]|10[0-7])(?:;|m)/u);
          }
          expect(sanitizePlainText(styled)).toContain('warning');
          expect(sanitizePlainText(styled)).toContain('critical');
        }
      }
    }
  });

  it('wraps whole left segments and keeps a right group at the terminal edge', () => {
    const wrapping = testConfig({ style: 'minimal', padding: 0, autoWrap: true });
    const wrapped = renderFooterLine(
      [segment('directory', 'alpha'), segment('git', 'bravo')],
      wrapping,
      getThemePalette(theme),
      'none',
      getSymbols('text'),
      8,
    );
    expect(wrapped).toEqual(['alpha', 'bravo']);

    const aligned = testConfig({ style: 'minimal', padding: 0 });
    const [line] = renderFooterLine(
      [segment('directory', 'left'), segment('model', 'right', 'right')],
      aligned,
      getThemePalette(theme),
      'none',
      getSymbols('text'),
      20,
    );
    expect(line).toBe('left           right');
    expect(visibleWidth(line!)).toBe(20);
  });

  it('pads ANSI-colored right-only groups to the terminal width', () => {
    const config = testConfig({ style: 'minimal', padding: 0 });
    const [line] = renderFooterLine(
      [segment('model', '界', 'right')],
      config,
      getThemePalette(theme),
      'truecolor',
      getSymbols('text'),
      10,
    );

    expect(line).toMatch(/^ {8}\x1b\[/);
    expect(visibleWidth(line!)).toBe(10);
  });
});

describe('powerline segments', () => {
  it('formats full, fish, and basename directory paths without host-home assumptions', () => {
    expect(renderSingle('directory', { enabled: true, style: 'full' }, context({ cwd: '/work/alpha/project' })).text).toBe('/work/alpha/project');
    expect(renderSingle('directory', { enabled: true, style: 'fish' }, context({ cwd: '/work/alpha/project' })).text).toBe('/w/a/project');
    expect(renderSingle('directory', { enabled: true, style: 'basename' }, context({ cwd: '/work/alpha/project' })).text).toBe('project');
  });

  it('renders model provider and thinking level when relevant', () => {
    const rendered = renderSingle('model', { enabled: true }, context({
      model: { id: 'model-x', provider: 'provider-x', reasoning: true, contextWindow: 100_000 },
      thinkingLevel: 'high',
      providerCount: 2,
    }));
    expect(rendered.text).toBe('(provider-x) model-x • high');
  });

  it('renders a sanitized Felan version and omits it when the host has none', () => {
    expect(renderSingle('version', { enabled: true }, context({ felanVersion: '0.26.14\n\u001b[31m' })))
      .toMatchObject({ name: 'version', colorKey: 'version', text: 'Felan 0.26.14' });
    const hostless = context();
    expect(renderSegments({ segments: { version: { enabled: true } } }, hostless)).toEqual([]);
  });

  it('totals session tokens, cache usage, and cost', () => {
    const rendered = renderSingle('session', { enabled: true, type: 'breakdown' }, context({
      entries: [
        assistantEntry(1_200, 300, 400, 50, 0.1234),
        { type: 'message', message: { role: 'user', content: 'ignored' } },
        assistantEntry(800, 700, 100, 50, 0.1),
      ],
    }));
    expect(rendered.text).toBe('in2.0k out1.0k R500 W100 $0.223');
  });

  it('adds usage supplied for related sessions to the root session totals', () => {
    const rendered = renderSingle('session', { enabled: true, type: 'breakdown' }, context({
      entries: [assistantEntry(1_200, 300, 400, 50, 0.1234)],
      additionalSessionUsage: {
        input: 800,
        output: 700,
        cacheRead: 100,
        cacheWrite: 50,
        cost: 0.1,
      },
    }));
    expect(rendered.text).toBe('in2.0k out1.0k R500 W100 $0.223');
  });

  it('renders labeled savings with the default period and unpriced marker', () => {
    const rendered = renderSingle('savings', { enabled: true }, context({ savings: {
      loading: false,
      result: { savedCostUsd: 33, hasUnpricedMeasurements: true },
    } }));
    expect(rendered).toMatchObject({ name: 'savings', colorKey: 'savings', text: 'Est. Savings(7d): ~$33.00' });
  });

  it('renders savings with the configured period', () => {
    const rendered = renderSingle('savings', { enabled: true, periodDays: 14 }, context({ savings: {
      loading: false,
      result: { savedCostUsd: 12.5, hasUnpricedMeasurements: false },
    } }));
    expect(rendered.text).toBe('Est. Savings(14d): $12.50');
  });

  it('renders Codex remaining usage and Claude used usage', () => {
    const codex = renderSingle('subscription', {
      enabled: true,
      showProviderName: false,
      showReset: true,
    }, context({
      model: { provider: 'openai-codex', id: 'gpt-5.6-sol' },
      subscription: {
        provider: 'codex',
        loading: false,
        usage: {
          provider: 'codex',
          displayName: 'Codex Plan',
          windows: [
            { label: 'Week', usedPercent: 41, resetDescription: '5d8h' },
            { label: '5h', usedPercent: 12, resetDescription: '2h' },
          ],
        },
      },
    }));
    expect(codex.text).toBe('7d 59% | 5d8h * 5h 88% | 2h');

    const claude = renderSingle('subscription', {
      enabled: true,
      showProviderName: true,
      showReset: false,
    }, context({
      model: { provider: 'anthropic', id: 'claude-opus-4-6' },
      subscription: {
        provider: 'anthropic',
        loading: false,
        usage: {
          provider: 'anthropic',
          displayName: 'Claude Plan',
          windows: [{ label: 'Week', usedPercent: 41 }],
        },
      },
    }));
    expect(claude.text).toBe('Claude 7d 41%');

    const grok = renderSingle('subscription', {
      enabled: true,
      showProviderName: false,
      showReset: true,
    }, context({
      model: { provider: 'xai', id: 'grok-4.6' },
      subscription: {
        provider: 'xai',
        loading: false,
        usage: {
          provider: 'xai',
          displayName: 'Grok Plan',
          windows: [{ label: 'Week', usedPercent: 43, resetDescription: '2d' }],
        },
      },
    }));
    expect(grok.text).toBe('7d 57% | 2d');

    const grokNamed = renderSingle('subscription', {
      enabled: true,
      showProviderName: true,
      showReset: false,
    }, context({
      model: { provider: 'xai', id: 'grok-4.6' },
      subscription: {
        provider: 'xai',
        loading: false,
        usage: {
          provider: 'xai',
          displayName: 'Grok Plan',
          windows: [{ label: 'Week', usedPercent: 43 }],
        },
      },
    }));
    expect(grokNamed.text).toBe('Grok 7d 57%');

    const grokLoading = renderSingle('subscription', { enabled: true }, context({
      model: { provider: 'xai', id: 'grok-4.6' },
      subscription: { provider: 'xai', loading: true },
    }));
    expect(grokLoading.text).toBe('Grok …');

    const grokNoOAuth = renderSingle('subscription', { enabled: true }, context({
      model: { provider: 'xai', id: 'grok-4.6' },
      subscription: {
        provider: 'xai',
        loading: false,
        usage: {
          provider: 'xai',
          displayName: 'Grok Plan',
          windows: [],
          error: { code: 'NO_CREDENTIALS', message: 'No OAuth credentials found' },
        },
      },
    }));
    expect(grokNoOAuth.text).toBe('Grok no OAuth');

    const claudeRateLimited = renderSingle('subscription', { enabled: true }, context({
      model: { provider: 'anthropic', id: 'claude-opus-4-6' },
      subscription: {
        provider: 'anthropic',
        loading: false,
        usage: {
          provider: 'anthropic',
          displayName: 'Claude Plan',
          windows: [],
          error: { code: 'HTTP_ERROR', message: 'HTTP 429', httpStatus: 429 },
        },
      },
    }));
    expect(claudeRateLimited.text).toBe('Claude usage unavailable');
  });

  it('renders ChatGPT remaining shared-plan usage and web-only fallback', () => {
    const usage = renderSingle('subscription', {
      enabled: true, showProviderName: true, showReset: true,
    }, context({
      model: { provider: 'openai', id: 'gpt-5.6' },
      subscription: {
        provider: 'openai', loading: false,
        usage: {
          provider: 'openai', displayName: 'ChatGPT Plan',
          windows: [{ label: '5h', usedPercent: 25, resetDescription: '2h' }],
        },
      },
    }));
    expect(usage.text).toBe('ChatGPT 5h 75% | 2h');
    const narrow = renderFooterLine(
      [usage],
      testConfig({ style: 'minimal', charset: 'text', padding: 0, autoWrap: false }),
      getThemePalette(theme),
      'none',
      getSymbols('text'),
      10,
    );
    expect(visibleWidth(narrow[0]!)).toBeLessThanOrEqual(10);

    const unavailable = renderSingle('subscription', { enabled: true }, context({
      model: { provider: 'openai', id: 'gpt-5.6' },
      subscription: {
        provider: 'openai', loading: false,
        usage: {
          provider: 'openai', displayName: 'ChatGPT Plan', windows: [],
          error: { code: 'COMPANION_UNAVAILABLE', message: 'ChatGPT usage requires a matching Codex login' },
        },
      },
    }));
    expect(unavailable.text).toBe('ChatGPT usage: web only');
  });

  it('renders context variants and threshold colors', () => {
    const warning = renderSingle('context', {
      enabled: true,
      displayStyle: 'bar',
      width: 4,
      warningThreshold: 60,
      criticalThreshold: 90,
    }, context({ contextUsage: { tokens: 70_000, contextWindow: 100_000, percent: 70 } }));
    expect(warning).toMatchObject({ colorKey: 'warning', text: 'ctx 70.0% ###-' });

    const critical = renderSingle('context', {
      enabled: true,
      displayStyle: 'text',
      criticalThreshold: 90,
    }, context({ contextUsage: { tokens: 95_000, contextWindow: 100_000, percent: 95 } }));
    expect(critical).toMatchObject({ colorKey: 'critical', text: 'ctx 95k/100k 95.0%' });

    const unknown = renderSingle('context', {
      enabled: true,
      displayStyle: 'dots',
      width: 3,
    }, context({ contextUsage: { tokens: null, contextWindow: 100_000, percent: null } }));
    expect(unknown.text).toBe('ctx ? ...');
  });

  it('uses cached Git details, footer branch state, and sorted sanitized statuses', () => {
    const ctx = context({
      branch: 'footer-main',
      statuses: new Map([
        ['z', '\x1b[31mbad\x1b[0m\nline'],
        ['a', 'ready'],
      ]),
    });
    const git = renderSingle('git', {
      enabled: true,
      showSha: true,
      showWorkingTree: true,
      showRepoName: true,
      showTag: true,
      showStashCount: true,
      showUpstream: true,
      showTimeSinceCommit: true,
    }, ctx, {
      branch: 'cached-main', sha: 'abc123', dirty: true, changedFiles: 2, repoName: 'repo', tag: 'v1',
      stashCount: 3, timeSinceCommit: '4m', upstream: { name: 'origin/main', ahead: 1, behind: 2 }, refreshedAt: 1,
    });
    expect(git.text).toBe('repo cached-main sha: abc123 2 tag: v1 4m stash 3 origin/main ahead1 behind2');

    const statuses = renderSegments({ segments: { status: { enabled: true } } }, ctx);
    expect(statuses.map((status) => status.text)).toEqual(['ready', 'bad line']);
    expect(statuses.map((status) => status.colorKey)).toEqual(['extensionStatus1', 'extensionStatus2']);
  });
});

function segment(name: SegmentName, text: string, align: 'left' | 'right' = 'left'): RenderedSegment {
  return { name, colorKey: name, text, align };
}

function testConfig(overrides: Partial<PowerlineConfig['display']>): PowerlineConfig {
  const config = DEFAULT_CONFIG;
  return { ...config, display: { ...config.display, ...overrides } };
}

function renderSingle(name: SegmentName, config: Record<string, unknown>, value: ReturnType<typeof context>, gitDetails?: SegmentValues['git'] & { refreshedAt?: number }): RenderedSegment {
  if (gitDetails) { const { refreshedAt: _refreshedAt, ...values } = gitDetails; value.data.segments.push({ name: 'git', colorKey: 'git', values }); }
  const savings = value.data.segments.find(segment => segment.name === 'savings');
  if (savings?.name === 'savings' && typeof config.periodDays === 'number') savings.values.periodDays = config.periodDays;
  const rendered = renderSegments({ segments: { [name]: config } }, value);
  expect(rendered).toHaveLength(1);
  return rendered[0]!;
}

function context(options: {
  cwd?: string; model?: Record<string, unknown>; thinkingLevel?: string; providerCount?: number; entries?: unknown[];
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null }; branch?: string | null;
  statuses?: ReadonlyMap<string, string>; felanVersion?: string; subscription?: SubscriptionState;
  savings?: { loading: boolean; result?: { savedCostUsd: number; hasUnpricedMeasurements: boolean } }; additionalSessionUsage?: SessionUsageTotals;
} = {}): Parameters<typeof renderSegments>[1] {
  const totals = getUsageTotals({ sessionManager: { getEntries: () => options.entries ?? [] } } as unknown as ExtensionContext, options.additionalSessionUsage);
  const data: PowerlineData = { segments: [
    { name: 'directory', colorKey: 'directory', values: { cwd: options.cwd ?? '/workspace' } },
    { name: 'session', colorKey: 'session', values: totals },
  ] };
  if (options.model) data.segments.push({ name: 'model', colorKey: 'model', values: { id: String(options.model.id ?? 'no-model'), provider: String(options.model.provider ?? ''), reasoning: !!options.model.reasoning, providerCount: options.providerCount ?? 1, ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}) } });
  if (options.contextUsage) data.segments.push({ name: 'context', colorKey: 'context', values: options.contextUsage });
  if (options.savings) data.segments.push({ name: 'savings', colorKey: 'savings', values: { ...options.savings, periodDays: 7 } });
  if (options.felanVersion) data.segments.push({ name: 'version', colorKey: 'version', values: { version: options.felanVersion } });
  if (options.subscription) {
    const { provider, loading, usage } = options.subscription;
    data.segments.push({ name: 'subscription', colorKey: 'subscription', values: { loading, ...(provider ? { provider } : {}), windows: usage?.windows ?? [], ...(usage?.error ? { error: usage.error } : {}) } });
  }
  return { data, symbols: getSymbols('text'), statuses: [...(options.statuses ?? new Map()).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text) };
}

function assistantEntry(input: number, output: number, cacheRead: number, cacheWrite: number, total: number) {
  return { type: 'message', message: { role: 'assistant', usage: { input, output, cacheRead, cacheWrite, cost: { total } } } };
}
