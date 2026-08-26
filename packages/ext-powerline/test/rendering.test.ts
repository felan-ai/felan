import type { ExtensionContext } from '@felan-ai/agent-core';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import { getThemePalette } from '../src/colors.js';
import { DEFAULT_CONFIG, type PowerlineConfig, type SegmentName } from '../src/config.js';
import { renderFooterLine, renderStyledSegments } from '../src/footer.js';
import { renderSegments, sanitizePlainText, type FooterDataLike, type RenderedSegment } from '../src/segments.js';
import type { SubscriptionState } from '../src/subscription.js';
import { getSymbols } from '../src/symbols.js';

describe('powerline rendering', () => {
  it('uses the customized palette as the built-in Felan theme', () => {
    expect(getThemePalette(DEFAULT_CONFIG).colors).toEqual({
      directory: { fg: '#ffffff', bg: '#1d4ed8' },
      git: { fg: '#111111', bg: '#a3be00' },
      model: { fg: '#475569', bg: '#11151c' },
      session: { fg: '#facc15', bg: '#11151c' },
      subscription: { fg: '#475569', bg: '#11151c' },
      context: { fg: '#22c55e', bg: '#11151c' },
      status: { fg: '#475569', bg: '#11151c' },
      warning: { fg: '#facc15', bg: '#11151c' },
      critical: { fg: '#f87171', bg: '#11151c' },
      muted: { fg: '#475569', bg: '#11151c' },
      extensionStatus1: { fg: '#cbd5e1', bg: '#1f2937' },
      extensionStatus2: { fg: '#bfdbfe', bg: '#1e3a5f' },
      extensionStatus3: { fg: '#ddd6fe', bg: '#3b2f5f' },
      extensionStatus4: { fg: '#99f6e4', bg: '#134e4a' },
    });
  });

  it('uses custom colors with built-in fallbacks', () => {
    const config: PowerlineConfig = {
      ...testConfig({}),
      theme: 'custom',
      colors: { custom: { directory: { fg: '#ffffff', bg: '#123456' } } },
    };

    const palette = getThemePalette(config);
    expect(palette.colors.directory).toEqual({ fg: '#ffffff', bg: '#123456' });
    expect(palette.colors.git).toBeDefined();
    expect(palette.colors.subscription).toBeDefined();
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
      expect(renderStyledSegments(segments, config, getThemePalette(config), 'none', getSymbols('text'))).toBe(expected[style]);
    }

    const unicode = testConfig({ style: 'powerline', charset: 'unicode', padding: 0 });
    expect(renderStyledSegments(segments, unicode, getThemePalette(unicode), 'none', getSymbols('unicode'))).toBe('onetwo');
  });

  it('measures ANSI-colored content by visible width and truncates safely', () => {
    const config = testConfig({ style: 'powerline', charset: 'unicode', padding: 1, autoWrap: false });
    const lines = renderFooterLine(
      [segment('directory', '界界界界')],
      config,
      getThemePalette(config),
      'truecolor',
      getSymbols('unicode'),
      7,
    );

    expect(lines[0]).toContain('\x1b[');
    expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(7);
    expect(sanitizePlainText(lines[0]!)).not.toContain('\x1b');
  });

  it('wraps whole left segments and keeps a right group at the terminal edge', () => {
    const wrapping = testConfig({ style: 'minimal', padding: 0, autoWrap: true });
    const wrapped = renderFooterLine(
      [segment('directory', 'alpha'), segment('git', 'bravo')],
      wrapping,
      getThemePalette(wrapping),
      'none',
      getSymbols('text'),
      8,
    );
    expect(wrapped).toEqual(['alpha', 'bravo']);

    const aligned = testConfig({ style: 'minimal', padding: 0 });
    const [line] = renderFooterLine(
      [segment('directory', 'left'), segment('model', 'right', 'right')],
      aligned,
      getThemePalette(aligned),
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
      getThemePalette(config),
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
            { label: 'GPT-5.6 Week', usedPercent: 12, resetDescription: '2d' },
          ],
        },
      },
    }));
    expect(codex.text).toBe('7d 59% | 5d8h');

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
    expect(git.text).toBe('repo footer-main sha: abc123 2 tag: v1 4m stash 3 origin/main ahead1 behind2');

    const statuses = renderSegments({ segments: { status: { enabled: true } } }, {
      ctx: ctx.ctx,
      footerData: ctx.footerData,
      subscription: ctx.subscription,
      symbols: getSymbols('text'),
    });
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

function renderSingle(
  name: SegmentName,
  config: Record<string, unknown>,
  value: ReturnType<typeof context>,
  gitDetails?: Parameters<typeof renderSegments>[1]['gitDetails'],
): RenderedSegment {
  const rendered = renderSegments({ segments: { [name]: config } }, {
    ctx: value.ctx,
    footerData: value.footerData,
    ...(gitDetails === undefined ? {} : { gitDetails }),
    subscription: value.subscription,
    symbols: getSymbols('text'),
  });
  expect(rendered).toHaveLength(1);
  return rendered[0]!;
}

function context(options: {
  cwd?: string;
  model?: Record<string, unknown>;
  thinkingLevel?: string;
  providerCount?: number;
  entries?: unknown[];
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
  branch?: string | null;
  statuses?: ReadonlyMap<string, string>;
  subscription?: SubscriptionState;
} = {}): { ctx: ExtensionContext; footerData: FooterDataLike; subscription: SubscriptionState } {
  const ctx = {
    cwd: options.cwd ?? '/workspace',
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    sessionManager: { getEntries: () => options.entries ?? [] },
    getContextUsage: () => options.contextUsage,
  } as unknown as ExtensionContext;
  const footerData: FooterDataLike = {
    getGitBranch: () => options.branch ?? null,
    getExtensionStatuses: () => options.statuses ?? new Map(),
    getAvailableProviderCount: () => options.providerCount ?? 1,
    onBranchChange: () => () => {},
  };
  return { ctx, footerData, subscription: options.subscription ?? { loading: false } };
}

function assistantEntry(input: number, output: number, cacheRead: number, cacheWrite: number, total: number) {
  return {
    type: 'message',
    message: { role: 'assistant', usage: { input, output, cacheRead, cacheWrite, cost: { total } } },
  };
}
