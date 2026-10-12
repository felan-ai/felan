import type { ExtensionContext, FelanExtensionAPI } from '@felan-ai/agent-core';
import { truncateToWidth, visibleWidth, type Component, type TUI } from '@earendil-works/pi-tui';
import {
  getThemePalette,
  type ColorMode,
} from './colors.js';
import type { PowerlineConfig } from './config.js';
import { GitCache } from './git.js';
import {
  renderSegments,
  type FooterDataLike,
  type SessionUsageTotals,
} from './segments.js';
import type { SubscriptionState } from './subscription.js';
import type { SavingsState } from './savings.js';
import { getSymbols } from './symbols.js';
import { renderFooterLine } from './footer-renderer.js';

export type FooterRowsRenderer = (width: number) => readonly string[];

export interface PowerlineFooterOptions {
  pi: FelanExtensionAPI;
  ctx: ExtensionContext;
  tui: TUI;
  footerData: FooterDataLike;
  theme: Parameters<typeof getThemePalette>[0];
  config: PowerlineConfig;
  felanVersion?: string;
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
    // Read the context theme on every render so Pi theme changes are reflected
    // without requiring the footer factory to be installed again.
    const palette = getThemePalette(this.options.ctx.ui.theme);
    const mode: ColorMode = 'truecolor';
    const lines: string[] = [];

    for (const line of config.display.lines) {
      const gitDetails = this.gitCache.get();
      const segments = renderSegments(line, {
        ctx: this.options.ctx,
        ...(this.options.felanVersion === undefined ? {} : { felanVersion: this.options.felanVersion }),
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

export { renderFooterLine, renderStyledSegments } from './footer-renderer.js';

function ensureWidth(line: string, width: number): string {
  return visibleWidth(line) <= width ? line : truncateToWidth(line, width, '…');
}
