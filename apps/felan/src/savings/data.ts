import type { UiValues } from '@felan-ai/agent-core';

export const SAVINGS_DASHBOARD_HINT = Object.freeze({ id: 'felan.savings-dashboard', version: '1' });

export const SAVINGS_ACTIONS = Object.freeze({ refresh: 'refresh', close: 'close' } as const);
export const SAVINGS_RANGES = ['today', '7d', '30d', '90d', 'all'] as const;
export const SAVINGS_TABS = ['overview', 'extensions', 'sessions', 'projects'] as const;
export const SAVINGS_CATEGORIES = ['output-optimization', 'model-routing', 'context-management', 'other'] as const;
export const SAVINGS_DEFAULT_RANGE: SavingsRangeId = '30d';
export const SAVINGS_TEXT_BYTES = 256;
/** The insights dashboard budget. A larger dashboard is published without data, so clients show the Markdown fallback. */
export const SAVINGS_DASHBOARD_BYTES = 512 * 1024;

export type SavingsRangeId = typeof SAVINGS_RANGES[number];
export type SavingsTabId = typeof SAVINGS_TABS[number];
export type SavingsCategoryId = typeof SAVINGS_CATEGORIES[number];
export type SavingsBasisKind = 'observed-comparison' | 'estimated-baseline';

/** Priced decisions only. `savedUsd` and `savedTokens` are signed; negative values are added cost. */
export interface SavingsAmount {
  savedUsd: number;
  baselineUsd: number;
  actualUsd: number;
  decisions: number;
  savedTokens: number;
}

/** The per-session subset of `SavingsAmount`, which keeps the payload small for long histories. */
export type SavingsShare = Pick<SavingsAmount, 'savedUsd' | 'decisions' | 'savedTokens'>;

/** Decisions without a resolvable price, excluded from every USD figure. */
export interface SavingsUnpriced { decisions: number; savedTokens: number }

export interface SavingsExtensionInfo { id: string; label: string; category: SavingsCategoryId }
export interface SavingsProjectInfo { label: string }
export interface SavingsSessionInfo {
  id: string;
  title: string;
  project: number;
  lastDay: string;
  /** All-time totals of this session, per extension. */
  extensions: Array<SavingsShare & { extension: number }>;
}

export interface SavingsOperationRow extends SavingsAmount { operation: string; basis: SavingsBasisKind; method: string }

export interface SavingsRangeView {
  id: SavingsRangeId;
  label: string;
  /** Inclusive UTC days, matching how measurements are stored; `from` is absent for all time. */
  from?: string;
  to: string;
  totals: SavingsAmount;
  unpriced: SavingsUnpriced;
  currentSession: SavingsAmount;
  currentProject: SavingsAmount;
  categories: Array<SavingsAmount & { category: SavingsCategoryId }>;
  extensions: Array<SavingsAmount & { extension: number; operations: SavingsOperationRow[] }>;
  sessions: Array<SavingsShare & { session: number }>;
  projects: Array<SavingsAmount & { project: number; sessions: number }>;
  trend: { granularity: 'day' | 'month'; points: Array<SavingsAmount & { period: string }> };
  omittedSessions: number;
}

export interface SavingsDashboard {
  generatedAt: string;
  firstDay?: string;
  lastDay?: string;
  initialRange: SavingsRangeId;
  initialTab: SavingsTabId;
  currentSession?: number;
  currentProject?: number;
  extensions: SavingsExtensionInfo[];
  sessions: SavingsSessionInfo[];
  projects: SavingsProjectInfo[];
  /** One view per `SAVINGS_RANGES` entry, in that order. */
  ranges: SavingsRangeView[];
  diagnostics: string[];
}

const encoder = new TextEncoder();
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const AMOUNT_KEYS = ['savedUsd', 'baselineUsd', 'actualUsd', 'decisions', 'savedTokens'] as const;
const SHARE_KEYS = ['savedUsd', 'decisions', 'savedTokens'] as const;

const bytes = (value: string) => encoder.encode(value).length;
function invalid(): never { throw new Error('Invalid savings dashboard data.'); }

export function savingsRangeDays(id: SavingsRangeId): number | undefined {
  return id === 'all' ? undefined : id === 'today' ? 1 : Number(id.slice(0, -1));
}

export function savingsRangeLabel(id: SavingsRangeId): string {
  const days = savingsRangeDays(id);
  return days === undefined ? 'All time' : days === 1 ? 'Today (UTC)' : `Last ${days} days`;
}

export function savingsCategoryLabel(category: SavingsCategoryId): string {
  return category.split('-').map((word, position) => position === 0 ? `${word[0]!.toUpperCase()}${word.slice(1)}` : word).join(' ');
}

export function formatSavingsUsd(value: number): string {
  const digits = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${value < 0 && digits !== '0.00' ? '-' : ''}$${digits}`;
}

/** Signed token counts; negative means the optimization used more tokens than its baseline. */
export function formatSavingsTokens(value: number): string {
  const size = Math.abs(value);
  const digits = size >= 1e9 ? `${(size / 1e9).toFixed(1)}B` : size >= 1e6 ? `${(size / 1e6).toFixed(1)}M`
    : size >= 1e3 ? `${(size / 1e3).toFixed(1)}K` : String(size);
  return `${value < 0 ? '-' : ''}${digits.replace(/\.0(?=[KMB])/u, '')}`;
}

/** Token impact as prose, so a routing decision that uses more tokens never reads as negative savings. */
export function formatSavingsTokenImpact(value: number): string {
  return value === 0 ? 'no token change' : `${formatSavingsTokens(Math.abs(value))} ${value > 0 ? 'fewer' : 'more'} tokens`;
}

/** Turns untrusted text, such as a session title, into one bounded display line. */
export function savingsText(value: string, maxBytes = SAVINGS_TEXT_BYTES): string {
  const chars = Array.from(value.replace(/[\s\u0000-\u001f\u007f-\u009f]+/gu, ' ').trim(), char => {
    const code = char.codePointAt(0)!;
    return code >= 0xd800 && code <= 0xdfff ? '\uFFFD' : char;
  });
  const line = chars.join('');
  if (bytes(line) <= maxBytes) return line;
  let clipped = '';
  let size = bytes('…');
  for (const char of chars) {
    size += bytes(char);
    if (size > maxBytes) break;
    clipped += char;
  }
  return `${clipped}…`;
}

export function encodeSavingsDashboard(dashboard: SavingsDashboard): UiValues | undefined {
  const encoded = JSON.stringify(parseSavingsDashboard(dashboard));
  return bytes(encoded) > SAVINGS_DASHBOARD_BYTES ? undefined : { dashboard: encoded };
}

export function readSavingsDashboard(data: UiValues | undefined): SavingsDashboard {
  const encoded = data?.dashboard;
  if (typeof encoded !== 'string' || bytes(encoded) > SAVINGS_DASHBOARD_BYTES) invalid();
  let value: unknown;
  try { value = JSON.parse(encoded); } catch { invalid(); }
  return parseSavingsDashboard(value);
}

export function parseSavingsDashboard(value: unknown): SavingsDashboard {
  const source = record(value, ['generatedAt', 'initialRange', 'initialTab', 'extensions', 'sessions', 'projects', 'ranges', 'diagnostics'],
    ['firstDay', 'lastDay', 'currentSession', 'currentProject']);
  const extensions = list(source.extensions, entry => {
    const row = record(entry, ['id', 'label', 'category']);
    return { id: text(row.id), label: text(row.label), category: category(row.category) };
  });
  const projects = list(source.projects, entry => ({ label: text(record(entry, ['label']).label) }));
  const sessions = list(source.sessions, entry => {
    const row = record(entry, ['id', 'title', 'project', 'lastDay', 'extensions']);
    return {
      id: text(row.id), title: text(row.title), project: index(row.project, projects.length), lastDay: day(row.lastDay),
      extensions: list(row.extensions, entry => ({ ...share(entry, ['extension']), extension: index(record(entry, [...SHARE_KEYS, 'extension']).extension, extensions.length) })),
    };
  });
  const ranges = list(source.ranges, entry => rangeView(entry, extensions.length, sessions.length, projects.length));
  if (ranges.length !== SAVINGS_RANGES.length || ranges.some((range, position) => range.id !== SAVINGS_RANGES[position])) invalid();
  const firstDay = source.firstDay === undefined ? undefined : day(source.firstDay);
  const lastDay = source.lastDay === undefined ? undefined : day(source.lastDay);
  if ((firstDay === undefined) !== (lastDay === undefined) || firstDay !== undefined && firstDay > lastDay!) invalid();
  return {
    generatedAt: instant(source.generatedAt),
    ...(firstDay === undefined ? {} : { firstDay, lastDay: lastDay! }),
    initialRange: member(source.initialRange, SAVINGS_RANGES),
    initialTab: member(source.initialTab, SAVINGS_TABS),
    ...(source.currentSession === undefined ? {} : { currentSession: index(source.currentSession, sessions.length) }),
    ...(source.currentProject === undefined ? {} : { currentProject: index(source.currentProject, projects.length) }),
    extensions, sessions, projects, ranges,
    diagnostics: list(source.diagnostics, entry => text(entry)),
  };
}

function rangeView(value: unknown, extensionCount: number, sessionCount: number, projectCount: number): SavingsRangeView {
  const source = record(value, ['id', 'label', 'to', 'totals', 'unpriced', 'currentSession', 'currentProject', 'categories', 'extensions',
    'sessions', 'projects', 'trend', 'omittedSessions'], ['from']);
  const id = member(source.id, SAVINGS_RANGES);
  const to = day(source.to);
  const from = source.from === undefined ? undefined : day(source.from);
  if ((from === undefined) !== (id === 'all') || from !== undefined && from > to) invalid();
  const unpriced = record(source.unpriced, ['decisions', 'savedTokens']);
  const trend = record(source.trend, ['granularity', 'points']);
  const granularity = member(trend.granularity, ['day', 'month'] as const);
  const points = list(trend.points, entry => {
    const period = record(entry, [...AMOUNT_KEYS, 'period']).period;
    return { ...amount(entry, ['period']), period: granularity === 'day' ? day(period) : month(period) };
  });
  if (points.some((point, position) => position > 0 && point.period <= points[position - 1]!.period)) invalid();
  return {
    id, label: text(source.label), ...(from === undefined ? {} : { from }), to,
    totals: amount(source.totals), unpriced: { decisions: count(unpriced.decisions), savedTokens: signedCount(unpriced.savedTokens) },
    currentSession: amount(source.currentSession), currentProject: amount(source.currentProject),
    categories: list(source.categories, entry => ({ ...amount(entry, ['category']), category: category(record(entry, [...AMOUNT_KEYS, 'category']).category) })),
    extensions: list(source.extensions, entry => {
      const row = record(entry, [...AMOUNT_KEYS, 'extension', 'operations']);
      return {
        ...amount(entry, ['extension', 'operations']), extension: index(row.extension, extensionCount),
        operations: list(row.operations, operation => {
          const fields = record(operation, [...AMOUNT_KEYS, 'operation', 'basis', 'method']);
          return {
            ...amount(operation, ['operation', 'basis', 'method']), operation: text(fields.operation),
            basis: member(fields.basis, ['observed-comparison', 'estimated-baseline'] as const), method: text(fields.method),
          };
        }),
      };
    }),
    sessions: list(source.sessions, entry => ({ ...share(entry, ['session']), session: index(record(entry, [...SHARE_KEYS, 'session']).session, sessionCount) })),
    projects: list(source.projects, entry => {
      const row = record(entry, [...AMOUNT_KEYS, 'project', 'sessions']);
      return { ...amount(entry, ['project', 'sessions']), project: index(row.project, projectCount), sessions: count(row.sessions) };
    }),
    trend: { granularity, points },
    omittedSessions: count(source.omittedSessions),
  };
}

function amount(value: unknown, extra: readonly string[] = []): SavingsAmount {
  const source = record(value, [...AMOUNT_KEYS, ...extra]);
  return {
    savedUsd: signed(source.savedUsd), baselineUsd: unsigned(source.baselineUsd), actualUsd: unsigned(source.actualUsd),
    decisions: count(source.decisions), savedTokens: signedCount(source.savedTokens),
  };
}

function share(value: unknown, extra: readonly string[]): SavingsShare {
  const source = record(value, [...SHARE_KEYS, ...extra]);
  return { savedUsd: signed(source.savedUsd), decisions: count(source.decisions), savedTokens: signedCount(source.savedTokens) };
}

function category(value: unknown): SavingsCategoryId { return member(value, SAVINGS_CATEGORIES); }

function member<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) invalid();
  return value as T;
}

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  if (Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) invalid();
  return value as Record<string, unknown>;
}

function list<T>(value: unknown, item: (entry: unknown) => T): T[] {
  if (!Array.isArray(value)) invalid();
  return value.map(entry => item(entry));
}

function text(value: unknown, maxBytes = SAVINGS_TEXT_BYTES): string {
  if (typeof value !== 'string' || bytes(value) > maxBytes || CONTROL.test(value) || LONE_SURROGATE.test(value)) invalid();
  return value;
}

function index(value: unknown, length: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= length) invalid();
  return value as number;
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

function signedCount(value: unknown): number {
  if (!Number.isSafeInteger(value)) invalid();
  return value as number;
}

function signed(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid();
  return value;
}

function unsigned(value: unknown): number {
  if (signed(value) < 0) invalid();
  return value as number;
}

function instant(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) invalid();
  return value;
}

function day(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/u.test(value)) invalid();
  instant(`${value}T00:00:00.000Z`);
  return value;
}

function month(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d$/u.test(value)) invalid();
  day(`${value}-01`);
  return value;
}
