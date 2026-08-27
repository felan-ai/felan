import type { ExtensionContext, FelanExtensionAPI } from '@felan-ai/agent-core';
import { truncateToWidth, visibleWidth, type Component, type TUI } from '@earendil-works/pi-tui';
import {
  colorBlock,
  colorForeground,
  colorPairText,
  getThemePalette,
  resolveColorMode,
  type ColorMode,
  type ThemePalette,
} from './colors.js';
import type { PowerlineConfig } from './config.js';
import { GitCache } from './git.js';
import {
  renderSegments,
  type FooterDataLike,
  type RenderedSegment,
  type SessionUsageTotals,
} from './segments.js';
import type { SubscriptionState } from './subscription.js';
import type { SavingsState } from './savings.js';
import { getSymbols, type PowerlineSymbols } from './symbols.js';

export type FooterRowsRenderer = (width: number) => readonly string[];

export interface PowerlineFooterOptions {
  pi: FelanExtensionAPI;
  ctx: ExtensionContext;
  tui: TUI;
  footerData: FooterDataLike;
  config: PowerlineConfig;
  subscription: SubscriptionState;
  savings?: SavingsState | (() => SavingsState);
  additionalSessionUsage?: SessionUsageTotals | (() => SessionUsageTotals);
  footerRows?: FooterRowsRenderer;
}

export class PowerlineFooter implements Component {
  private readonly gitCache: GitCache;
  private readonly unsubscribeBranch: () => void;
  private disposed = false;

  constructor(private readonly options: PowerlineFooterOptions) {
    this.gitCache = new GitCache(options.pi, options.ctx.cwd);
    this.unsubscribeBranch = options.footerData.onBranchChange(() => this.invalidate());
    this.refreshGit();
  }

  invalidate(): void {
    this.refreshGit();
    this.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeBranch();
    this.gitCache.dispose();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    if (safeWidth === 0) return [''];

    const { config } = this.options;
    const symbols = getSymbols(config.display.charset);
    const palette = getThemePalette(config);
    const mode = resolveColorMode(config.display.colorCompatibility);
    const lines: string[] = [];

    for (const line of config.display.lines) {
      const gitDetails = this.gitCache.get();
      const segments = renderSegments(line, {
        ctx: this.options.ctx,
        footerData: this.options.footerData,
        ...(gitDetails === undefined ? {} : { gitDetails }),
        subscription: this.options.subscription,
        ...(typeof this.options.savings === 'function'
          ? { savings: this.options.savings() }
          : this.options.savings === undefined ? {} : { savings: this.options.savings }),
        ...(typeof this.options.additionalSessionUsage === 'function'
          ? { additionalSessionUsage: this.options.additionalSessionUsage() }
          : this.options.additionalSessionUsage === undefined
            ? {}
            : { additionalSessionUsage: this.options.additionalSessionUsage }),
        symbols,
      });
      if (segments.length > 0) lines.push(...renderFooterLine(segments, config, palette, mode, symbols, safeWidth));
    }

    const footerLines = lines.length > 0 ? lines : [''];
    const extraRows = this.options.footerRows?.(safeWidth) ?? [];
    return [...footerLines, ...extraRows].map((line) => ensureWidth(line, safeWidth));
  }

  private refreshGit(): void {
    void this.gitCache.refresh().then(() => this.requestRender());
  }

  private requestRender(): void {
    if (!this.disposed) this.options.tui.requestRender();
  }
}

export function renderFooterLine(
  segments: RenderedSegment[],
  config: PowerlineConfig,
  palette: ThemePalette,
  mode: ColorMode,
  symbols: PowerlineSymbols,
  width: number,
): string[] {
  const left = segments.filter((segment) => segment.align === 'left');
  const right = segments.filter((segment) => segment.align === 'right');
  if (right.length > 0) return [renderAlignedLine(left, right, config, palette, mode, symbols, width)];
  if (!config.display.autoWrap) return [ensureWidth(renderStyledSegments(segments, config, palette, mode, symbols), width)];

  const lines: string[] = [];
  let current: RenderedSegment[] = [];
  for (const segment of segments) {
    const candidate = [...current, segment];
    if (current.length > 0 && visibleWidth(renderStyledSegments(candidate, config, palette, mode, symbols)) > width) {
      lines.push(ensureWidth(renderStyledSegments(current, config, palette, mode, symbols), width));
      current = [segment];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(ensureWidth(renderStyledSegments(current, config, palette, mode, symbols), width));
  return lines;
}

export function renderStyledSegments(
  segments: RenderedSegment[],
  config: PowerlineConfig,
  palette: ThemePalette,
  mode: ColorMode,
  symbols: PowerlineSymbols,
): string {
  if (config.display.style === 'minimal') return renderMinimal(segments, config, palette, mode, symbols);
  if (config.display.style === 'capsule') return renderCapsule(segments, config, palette, mode, symbols);
  return renderPowerline(segments, config, palette, mode, symbols);
}

function renderAlignedLine(
  leftSegments: RenderedSegment[],
  rightSegments: RenderedSegment[],
  config: PowerlineConfig,
  palette: ThemePalette,
  mode: ColorMode,
  symbols: PowerlineSymbols,
  width: number,
): string {
  const right = ensureWidth(renderStyledSegments(rightSegments, config, palette, mode, symbols), width);
  const rightWidth = visibleWidth(right);
  const leftAvailable = Math.max(0, width - rightWidth - (leftSegments.length > 0 ? 1 : 0));
  const left = leftAvailable > 0
    ? ensureWidth(renderStyledSegments(leftSegments, config, palette, mode, symbols), leftAvailable)
    : '';
  if (!left) return ' '.repeat(Math.max(0, width - rightWidth)) + right;
  return ensureWidth(left + ' '.repeat(Math.max(1, width - visibleWidth(left) - rightWidth)) + right, width);
}

function renderMinimal(
  segments: RenderedSegment[],
  config: PowerlineConfig,
  palette: ThemePalette,
  mode: ColorMode,
  symbols: PowerlineSymbols,
): string {
  const separator = colorForeground(` ${symbols.separatorThin} `, palette.colors.muted.fg, mode);
  return segments
    .map((segment) => colorPairText(pad(segment.text, config.display.padding), palette.colors[segment.colorKey], mode))
    .join(separator);
}

function renderPowerline(
  segments: RenderedSegment[],
  config: PowerlineConfig,
  palette: ThemePalette,
  mode: ColorMode,
  symbols: PowerlineSymbols,
): string {
  let output = '';
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const pair = palette.colors[segment.colorKey];
    const next = segments[index + 1];
    output += colorBlock(pad(segment.text, config.display.padding), pair, mode);
    output += next
      ? colorBlock(symbols.separator, { fg: pair.bg, bg: palette.colors[next.colorKey].bg }, mode)
      : colorForeground(symbols.separator, pair.bg, mode);
  }
  return output;
}

function renderCapsule(
  segments: RenderedSegment[],
  config: PowerlineConfig,
  palette: ThemePalette,
  mode: ColorMode,
  symbols: PowerlineSymbols,
): string {
  return segments.map((segment) => {
    const pair = palette.colors[segment.colorKey];
    return colorForeground(symbols.capsuleLeft, pair.bg, mode)
      + colorBlock(pad(segment.text, config.display.padding), pair, mode)
      + colorForeground(symbols.capsuleRight, pair.bg, mode);
  }).join(' ');
}

function pad(text: string, padding: number): string {
  return padding > 0 ? `${' '.repeat(padding)}${text}${' '.repeat(padding)}` : text;
}

function ensureWidth(line: string, width: number): string {
  return visibleWidth(line) <= width ? line : truncateToWidth(line, width, '…');
}
