import type { PowerlineData, SegmentValues } from '@felan-ai/ext-powerline/data';
import type { DisplayLineConfig, SegmentConfig, SegmentName, ThemeColorKey } from './config.js';
import { BAR_LEVELS, type PowerlineSymbols } from './symbols.js';

type RateWindow = SegmentValues['subscription']['windows'][number];
type SubscriptionProviderName = NonNullable<SegmentValues['subscription']['provider']>;
export interface SegmentRenderContext { data: PowerlineData; symbols: PowerlineSymbols; statuses?: readonly string[] }
function values<K extends keyof SegmentValues>(context: SegmentRenderContext, name: K): SegmentValues[K] | undefined {
  return context.data.segments.find(segment => segment.name === name)?.values as SegmentValues[K] | undefined;
}
export interface RenderedSegment {
  name: SegmentName;
  colorKey: ThemeColorKey;
  text: string;
  align: 'left' | 'right';
}

const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const EXTENSION_STATUS_COLORS: ThemeColorKey[] = ['extensionStatus1', 'extensionStatus2', 'extensionStatus3', 'extensionStatus4'];

export function renderSegments(line: DisplayLineConfig, context: SegmentRenderContext): RenderedSegment[] {
  const segments: RenderedSegment[] = [];
  for (const [name, config] of Object.entries(line.segments) as [SegmentName, SegmentConfig][]) {
    if (!config.enabled) continue;
    const rendered = renderSegment(name, config, context);
    const values = Array.isArray(rendered) ? rendered : rendered ? [rendered] : [];
    const color = context.data.segments.find(segment => segment.name === name)?.colorKey;
    for (const segment of values) {
      if (segment.text.trim()) segments.push({ ...segment, colorKey: config.colorKey ?? (color && color !== name ? color : segment.colorKey), align: config.align ?? 'left' });
    }
  }
  return segments;
}

export function sanitizePlainText(value: string): string {
  return value
    .replace(ANSI_PATTERN, '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/ +/g, ' ')
    .trim();
}

export function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function renderSegment(
  name: SegmentName,
  config: SegmentConfig,
  context: SegmentRenderContext,
): Omit<RenderedSegment, 'align'> | Omit<RenderedSegment, 'align'>[] | undefined {
  if (name !== 'status' && !context.data.segments.some(segment => segment.name === name)) return undefined;
  switch (name) {
    case 'directory': return renderDirectory(config, context);
    case 'git': return renderGit(config, context);
    case 'model': return renderModel(context);
    case 'session': return renderSession(config, context);
    case 'subscription': return renderSubscription(config, context);
    case 'savings': return renderSavings(context);
    case 'context': return renderContext(config, context);
    case 'status': return renderStatus(context);
    case 'version': { const version = values(context, 'version')?.version; return version ? { name: 'version', colorKey: 'version', text: `Felan ${sanitizePlainText(version)}` } : undefined; }
  }
}

function renderDirectory(config: SegmentConfig, context: SegmentRenderContext): Omit<RenderedSegment, 'align'> {
  const style = config.style ?? 'fish';
  const cwd = values(context, 'directory')?.cwd ?? '';
  const text = style === 'basename' ? basename(cwd) : style === 'full' ? cwd : fishPath(cwd);
  return { name: 'directory', colorKey: 'directory', text: sanitizePlainText(text) };
}

function renderGit(config: SegmentConfig, context: SegmentRenderContext): Omit<RenderedSegment, 'align'> | undefined {
  const details = values(context, 'git');
  const branch = sanitizePlainText(details?.branch ?? '');
  const parts: string[] = [];
  if (config.showRepoName && details?.repoName) parts.push(sanitizePlainText(details.repoName));
  if (branch) parts.push(formatWithOptionalSymbol(context.symbols.branch, branch));
  if (config.showSha && details?.sha) parts.push(formatWithOptionalSymbol(context.symbols.sha, sanitizePlainText(details.sha)));
  if (details) {
    const workingTree = formatWorkingTree(details, context.symbols);
    if (workingTree) parts.push(workingTree);
  }
  if (config.showTag && details?.tag) parts.push(`${context.symbols.tag} ${sanitizePlainText(details.tag)}`);
  if (config.showTimeSinceCommit && details?.timeSinceCommit) parts.push(`${context.symbols.clock} ${details.timeSinceCommit}`.trim());
  if (details?.stashCount) parts.push(`${context.symbols.stash} ${details.stashCount}`);
  if (config.showUpstream && details?.upstream) {
    const upstream: string[] = [];
    if (details.upstream.name) upstream.push(sanitizePlainText(details.upstream.name));
    if (details.upstream.ahead) upstream.push(`${context.symbols.ahead}${details.upstream.ahead}`);
    if (details.upstream.behind) upstream.push(`${context.symbols.behind}${details.upstream.behind}`);
    if (upstream.length > 0) parts.push(upstream.join(' '));
  }
  return parts.length > 0 ? { name: 'git', colorKey: 'git', text: parts.join(' ') } : undefined;
}

function renderModel(context: SegmentRenderContext): Omit<RenderedSegment, 'align'> {
  const model = values(context, 'model');
  let text = model?.id ?? 'no-model';
  if (model && model.providerCount > 1) text = `(${model.provider}) ${text}`;
  if (model?.reasoning && model.thinkingLevel) text = `${text} • ${model.thinkingLevel}`;
  return { name: 'model', colorKey: 'model', text: sanitizePlainText(text) };
}

function renderSession(config: SegmentConfig, context: SegmentRenderContext): Omit<RenderedSegment, 'align'> {
  const totals = values(context, 'session') ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const tokenText = `${context.symbols.tokensIn}${formatTokens(totals.input)} ${context.symbols.tokensOut}${formatTokens(totals.output)}`;
  const cacheText = `${context.symbols.cacheRead}${formatTokens(totals.cacheRead)} ${context.symbols.cacheWrite}${formatTokens(totals.cacheWrite)}`;
  const costText = `$${totals.cost.toFixed(3)}`;
  const type = config.type ?? 'tokens';
  const text = type === 'cost'
    ? costText
    : type === 'both'
      ? `${tokenText} ${costText}`
      : type === 'breakdown'
        ? `${tokenText} ${cacheText} ${costText}`
        : tokenText;
  return { name: 'session', colorKey: 'session', text };
}

function renderSavings(context: SegmentRenderContext): Omit<RenderedSegment, 'align'> | undefined {
  const savings = values(context, 'savings') ?? { loading: false, periodDays: 7 };
  if (savings.loading && !savings.result) return { name: 'savings', colorKey: 'savings', text: 'savings …' };
  if (!savings.result) return undefined;
  const amount = savings.result.savedCostUsd;
  const estimate = `${savings.result.hasUnpricedMeasurements ? '~' : ''}${amount < 0 ? '-' : ''}$${Math.abs(amount).toFixed(2)}`;
  return { name: 'savings', colorKey: 'savings', text: `Est. Savings(${savings.periodDays}d): ${estimate}` };
}

function renderSubscription(
  config: SegmentConfig,
  context: SegmentRenderContext,
): Omit<RenderedSegment, 'align'> | undefined {
  const subscription = values(context, 'subscription');
  const provider = subscription?.provider;
  if (!provider) return undefined;

  const label = getSubscriptionProviderLabel(provider);
  const usage = subscription;
  if (subscription.loading && usage.windows.length === 0) {
    return { name: 'subscription', colorKey: 'subscription', text: sanitizePlainText(`${label} …`) };
  }
  if (usage.error?.code === 'NO_CREDENTIALS') {
    return { name: 'subscription', colorKey: 'warning', text: sanitizePlainText(`${label} no OAuth`) };
  }
  if (usage.error?.code === 'COMPANION_UNAVAILABLE') {
    return { name: 'subscription', colorKey: 'warning', text: 'ChatGPT usage: web only' };
  }

  const windows = usage.windows;
  if (windows.length === 0) {
    if (!usage.error) return undefined;
    return {
      name: 'subscription',
      colorKey: 'warning',
      text: sanitizePlainText(`${label} ${formatSubscriptionError(usage.error)}`),
    };
  }

  const parts = windows.map((window) => formatSubscriptionWindow(provider, window, config)).filter(Boolean);
  const text = [config.showProviderName ?? true ? label : '', parts.join(' * ')].filter(Boolean).join(' ');
  if (!text.trim()) return undefined;
  return {
    name: 'subscription',
    colorKey: usage.error ? 'warning' : 'subscription',
    text: sanitizePlainText(text),
  };
}

function renderContext(config: SegmentConfig, context: SegmentRenderContext): Omit<RenderedSegment, 'align'> | undefined {
  const usage = values(context, 'context');
  const contextWindow = usage?.contextWindow;
  if (!contextWindow) return undefined;

  const percent = usage?.percent ?? null;
  const tokens = usage?.tokens ?? null;
  const percentText = percent === null ? '?' : `${percent.toFixed(1)}%`;
  const ratio = percent === null ? 0 : clamp(percent / 100, 0, 1);
  const width = config.width ?? 10;
  const usageText = tokens === null ? `?/${formatTokens(contextWindow)}` : `${formatTokens(tokens)}/${formatTokens(contextWindow)}`;
  const style = config.displayStyle ?? 'bar';

  let text: string;
  if (config.showTokensOnly) text = `ctx ${usageText}`;
  else if (config.showPercentageOnly) text = `ctx ${percentText}`;
  else if (style === 'text') text = `ctx ${usageText} ${percentText}`;
  else if (style === 'dots') text = `ctx ${percentText} ${repeatProgress(context.symbols.dotFull, context.symbols.dotEmpty, ratio, width)}`;
  else if (style === 'blocks-line') text = renderBlockLine(ratio, width, context.symbols);
  else if (style === 'blocks') text = `ctx ${percentText} ${renderBlockLine(ratio, width, context.symbols)}`;
  else text = `ctx ${percentText} ${repeatProgress(context.symbols.blockFull, context.symbols.blockEmpty, ratio, width)}`;

  const warning = config.warningThreshold ?? 70;
  const critical = config.criticalThreshold ?? 90;
  const colorKey: ThemeColorKey = percent !== null && percent >= critical
    ? 'critical'
    : percent !== null && percent >= warning ? 'warning' : 'context';
  return { name: 'context', colorKey, text };
}

function renderStatus(context: SegmentRenderContext): Omit<RenderedSegment, 'align'>[] | undefined {
  const statuses = [...(context.statuses ?? [])].map(sanitizePlainText)
    .filter(Boolean);
  return statuses.length === 0 ? undefined : statuses.map((text, index) => ({
    name: 'status',
    colorKey: EXTENSION_STATUS_COLORS[index % EXTENSION_STATUS_COLORS.length]!,
    text,
  }));
}

function getSubscriptionProviderLabel(provider: SubscriptionProviderName): string {
  if (provider === 'openai') return 'ChatGPT';
  if (provider === 'codex') return 'Codex';
  if (provider === 'xai') return 'Grok';
  return 'Claude';
}

function formatSubscriptionWindow(
  provider: SubscriptionProviderName,
  window: RateWindow,
  config: SegmentConfig,
): string {
  if (provider === 'openai' || provider === 'codex' || provider === 'xai') {
    return formatCompactSubscriptionWindow(window, config, 100 - window.usedPercent);
  }
  return formatAnthropicWindow(window, config);
}

function formatAnthropicWindow(window: RateWindow, config: SegmentConfig): string {
  if (window.label.toLowerCase().startsWith('extra [')) {
    const reset = config.showReset ?? true ? formatWindowReset(window) : undefined;
    return reset ? `${window.label} | ${reset}` : window.label;
  }
  return formatCompactSubscriptionWindow(window, config, window.usedPercent);
}

function formatCompactSubscriptionWindow(
  window: RateWindow,
  config: SegmentConfig,
  percent: number,
): string {
  const parts = [formatSubscriptionLabel(window.label)];
  if (config.showPercentage ?? true) parts.push(`${Math.round(clamp(percent, 0, 100))}%`);
  const text = parts.join(' ');
  const reset = config.showReset ?? true ? formatWindowReset(window) : undefined;
  return reset ? `${text} | ${reset}` : text;
}

function formatSubscriptionLabel(label: string): string {
  const normalized = normalizeCodexWindowLabel(label);
  if (normalized === 'Week') return '7d';
  if (normalized === 'Day') return '24h';
  return normalized;
}

function formatWindowReset(window: RateWindow): string | undefined {
  if (window.resetDescription === '__ACTIVE__') return undefined;
  if (window.resetAt) {
    const resetAt = new Date(window.resetAt);
    if (Number.isFinite(resetAt.getTime())) return formatReset(resetAt);
  }
  return window.resetDescription;
}



function normalizeCodexWindowLabel(label: string): string {
  return label.match(/(?:^| )(5h|\d+h|Day|Week)$/)?.[1] ?? label;
}

function formatSubscriptionError(error: { code: string; httpStatus?: number }): string {
  if (error.code === 'COMPANION_UNAVAILABLE') return 'usage: web only';
  if (error.code === 'HTTP_ERROR' && error.httpStatus === 429) return 'usage unavailable';
  if (error.code === 'HTTP_ERROR' && error.httpStatus) return `HTTP ${error.httpStatus}`;
  return 'fetch failed';
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.at(-1) ?? path;
}

function fishPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  if (!normalized.includes('/')) return normalized;
  const prefix = normalized.startsWith('/') ? '/' : '';
  const parts = normalized.replace(/^\//, '').split('/').filter(Boolean);
  if (parts.length <= 1) return `${prefix}${parts.join('/')}`;
  return `${prefix}${[...parts.slice(0, -1).map((part) => part[0] ?? part), parts.at(-1)].join('/')}`;
}

function formatWithOptionalSymbol(symbol: string, text: string): string {
  return symbol ? `${symbol} ${text}` : text;
}

function formatWorkingTree(details: SegmentValues['git'], symbols: PowerlineSymbols): string | undefined {
  if (details.dirty === undefined) return undefined;
  if (!details.dirty) return symbols.clean || undefined;
  if (details.changedFiles !== undefined && details.changedFiles > 0) {
    return symbols.dirty ? `${symbols.dirty} ${details.changedFiles}` : String(details.changedFiles);
  }
  return symbols.dirty || undefined;
}

function repeatProgress(full: string, empty: string, ratio: number, width: number): string {
  const filled = Math.round(width * ratio);
  return `${full.repeat(filled)}${empty.repeat(Math.max(0, width - filled))}`;
}

function renderBlockLine(ratio: number, width: number, symbols: PowerlineSymbols): string {
  if (width <= 0) return '';
  if (symbols.blockFull !== '█') return repeatProgress(symbols.blockFull, symbols.blockEmpty, ratio, width);
  const exact = ratio * width;
  const fullBlocks = Math.floor(exact);
  const remainder = exact - fullBlocks;
  const partial = remainder > 0 && fullBlocks < width
    ? BAR_LEVELS[Math.max(0, Math.ceil(remainder * BAR_LEVELS.length) - 1)]
    : '';
  return `${symbols.blockFull.repeat(fullBlocks)}${partial}${symbols.blockEmpty.repeat(Math.max(0, width - fullBlocks - (partial ? 1 : 0)))}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatReset(date: Date): string {
  const minutes = Math.floor((date.getTime() - Date.now()) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d${hours % 24}h` : `${days}d`;
}
