import type { ExtensionContext } from '@felan-ai/agent-core';
import type { DisplayLineConfig, SegmentConfig, SegmentName, ThemeColorKey } from './config.js';
import type { GitDetails } from './git.js';
import { BAR_LEVELS, type PowerlineSymbols } from './symbols.js';

export interface FooterDataLike {
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  getAvailableProviderCount(): number;
  onBranchChange(callback: () => void): () => void;
}

export interface SegmentRenderContext {
  ctx: ExtensionContext;
  footerData: FooterDataLike;
  gitDetails?: GitDetails;
  symbols: PowerlineSymbols;
}

export interface RenderedSegment {
  name: SegmentName;
  colorKey: ThemeColorKey;
  text: string;
  align: 'left' | 'right';
}

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const EXTENSION_STATUS_COLORS: ThemeColorKey[] = ['extensionStatus1', 'extensionStatus2', 'extensionStatus3', 'extensionStatus4'];

export function renderSegments(line: DisplayLineConfig, context: SegmentRenderContext): RenderedSegment[] {
  const segments: RenderedSegment[] = [];
  for (const [name, config] of Object.entries(line.segments) as [SegmentName, SegmentConfig][]) {
    if (!config.enabled) continue;
    const rendered = renderSegment(name, config, context);
    const values = Array.isArray(rendered) ? rendered : rendered ? [rendered] : [];
    for (const segment of values) {
      if (segment.text.trim()) segments.push({ ...segment, align: config.align ?? 'left' });
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
  switch (name) {
    case 'directory': return renderDirectory(config, context);
    case 'git': return renderGit(config, context);
    case 'model': return renderModel(context);
    case 'session': return renderSession(config, context);
    case 'context': return renderContext(config, context);
    case 'status': return renderStatus(context);
  }
}

function renderDirectory(config: SegmentConfig, context: SegmentRenderContext): Omit<RenderedSegment, 'align'> {
  const style = config.style ?? 'fish';
  const cwd = context.ctx.cwd;
  const text = style === 'basename' ? basename(cwd) : style === 'full' ? cwd : fishPath(cwd);
  return { name: 'directory', colorKey: 'directory', text: sanitizePlainText(text) };
}

function renderGit(config: SegmentConfig, context: SegmentRenderContext): Omit<RenderedSegment, 'align'> | undefined {
  const details = context.gitDetails;
  const branch = sanitizePlainText(context.footerData.getGitBranch() ?? details?.branch ?? '');
  const parts: string[] = [];
  if (config.showRepoName && details?.repoName) parts.push(sanitizePlainText(details.repoName));
  if (branch) parts.push(formatWithOptionalSymbol(context.symbols.branch, branch));
  if (config.showSha && details?.sha) parts.push(formatWithOptionalSymbol(context.symbols.sha, sanitizePlainText(details.sha)));
  if (config.showWorkingTree && details) {
    const workingTree = formatWorkingTree(details, context.symbols);
    if (workingTree) parts.push(workingTree);
  }
  if (config.showTag && details?.tag) parts.push(`${context.symbols.tag} ${sanitizePlainText(details.tag)}`);
  if (config.showTimeSinceCommit && details?.timeSinceCommit) parts.push(`${context.symbols.clock} ${details.timeSinceCommit}`.trim());
  if (config.showStashCount && details?.stashCount) parts.push(`${context.symbols.stash} ${details.stashCount}`);
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
  const model = context.ctx.model;
  let text = model?.id ?? 'no-model';
  if (model && context.footerData.getAvailableProviderCount() > 1) text = `(${model.provider}) ${text}`;
  if (model?.reasoning && context.ctx.thinkingLevel) text = `${text} • ${context.ctx.thinkingLevel}`;
  return { name: 'model', colorKey: 'model', text: sanitizePlainText(text) };
}

function renderSession(config: SegmentConfig, context: SegmentRenderContext): Omit<RenderedSegment, 'align'> {
  const totals = getUsageTotals(context.ctx);
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

function renderContext(config: SegmentConfig, context: SegmentRenderContext): Omit<RenderedSegment, 'align'> | undefined {
  const usage = context.ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? context.ctx.model?.contextWindow;
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
  const statuses = [...context.footerData.getExtensionStatuses().entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, text]) => sanitizePlainText(text))
    .filter(Boolean);
  return statuses.length === 0 ? undefined : statuses.map((text, index) => ({
    name: 'status',
    colorKey: EXTENSION_STATUS_COLORS[index % EXTENSION_STATUS_COLORS.length]!,
    text,
  }));
}

function getUsageTotals(context: ExtensionContext): UsageTotals {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const entry of context.sessionManager.getEntries()) {
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
    totals.input += entry.message.usage.input;
    totals.output += entry.message.usage.output;
    totals.cacheRead += entry.message.usage.cacheRead;
    totals.cacheWrite += entry.message.usage.cacheWrite;
    totals.cost += entry.message.usage.cost.total;
  }
  return totals;
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

function formatWorkingTree(details: GitDetails, symbols: PowerlineSymbols): string | undefined {
  if (!details.dirty) return symbols.clean || undefined;
  if (details.changedFiles > 0) return symbols.dirty ? `${symbols.dirty} ${details.changedFiles}` : String(details.changedFiles);
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
