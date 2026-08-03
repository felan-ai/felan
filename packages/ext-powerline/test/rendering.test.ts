import type { ExtensionContext } from '@felan-ai/agent-core';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import { getThemePalette } from '../src/colors.js';
import { configFromFlags, type PowerlineConfig, type SegmentName } from '../src/config.js';
import { renderFooterLine, renderStyledSegments } from '../src/footer.js';
import { renderSegments, sanitizePlainText, type FooterDataLike, type RenderedSegment } from '../src/segments.js';
import { getSymbols } from '../src/symbols.js';

describe('powerline rendering', () => {
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
  const config = configFromFlags({ getFlag: () => undefined });
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
} = {}): { ctx: ExtensionContext; footerData: FooterDataLike } {
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
  return { ctx, footerData };
}

function assistantEntry(input: number, output: number, cacheRead: number, cacheWrite: number, total: number) {
  return {
    type: 'message',
    message: { role: 'assistant', usage: { input, output, cacheRead, cacheWrite, cost: { total } } },
  };
}
