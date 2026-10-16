import type { UiValues } from '@felan-ai/agent-core';

export const INSIGHTS_DOCUMENT_HINT = Object.freeze({ id: 'felan.insights-report', version: '2' });

export const INSIGHTS_ACTIONS = Object.freeze({
  range: 'range',
  search: 'sessions-search',
  previous: 'sessions-previous',
  next: 'sessions-next',
  openBrowser: 'open-browser',
  close: 'close',
} as const);
export const INSIGHTS_RANGE_FIELD = 'range';
export const INSIGHTS_QUERY_FIELD = 'query';
export const INSIGHTS_RANGE_PRESETS = ['7d', '30d', '90d', 'all'] as const;
export const INSIGHTS_DEFAULT_RANGE = '30d';
export const INSIGHTS_SESSIONS_PAGE_SIZE = 40;
export const INSIGHTS_QUERY_BYTES = 1024;
export const INSIGHTS_TEXT_BYTES = 256;
export const INSIGHTS_NOTICE_BYTES = 1024;
/** Larger dashboards are published without data, so clients show the Markdown fallback instead. */
export const INSIGHTS_MAX_RANGE_DAYS = 99_999_999;
export const INSIGHTS_DASHBOARD_BYTES = 512 * 1024;

export interface InsightsCount { name: string; count: number }
export interface InsightsDailyRow { date: string; sessions: number; messages: number; tokens: number; cost: number }
export interface InsightsModelRow {
  name: string; sessions: number; messages: number; tokens: number; cost: number;
  avgSessionMinutes: number; toolErrorsPerSession: number;
}
export interface InsightsProjectRow { name: string; sessions: number; messages: number; tokens: number; cost: number; durationMinutes: number }
export interface InsightsSessionRow {
  start: string; project: string; messages: number; tokens: number; durationMinutes: number; cost: number; models: string[];
}

export interface InsightsDashboard {
  generatedAt: string;
  /** `from` is absent for all time; `to` is the generation time. */
  range: { id: string; label: string; from?: string; to: string };
  loadedSessions: number;
  reportPath?: string;
  notice?: { level: 'info' | 'warning'; text: string };
  totals: {
    sessions: number; messages: number; userMessages: number; tokens: number; cost: number;
    durationMinutes: number; avgSessionMinutes: number; avgMessagesPerSession: number; multiModelSessions: number;
  };
  /** Active days keyed by UTC date, as `computeAnalytics` produces them. */
  daily: InsightsDailyRow[];
  /** Session starts by local hour on the host that computed the report. */
  hourly: number[];
  tools: InsightsCount[];
  models: InsightsModelRow[];
  projects: InsightsProjectRow[];
  thinkingLevels: InsightsCount[];
  stopReasons: InsightsCount[];
  rage: {
    total: number; messagesWithSwears: number; byModel: InsightsCount[]; byHour: number[]; byProject: InsightsCount[];
    topWords: Array<{ word: string; group: string; count: number }>;
  };
  sessions: { query: string; page: number; pageCount: number; matched: number; rows: InsightsSessionRow[] };
}

const PATH_BYTES = 4096;
const encoder = new TextEncoder();
const RANGE_ID = /^(?:all|[1-9]\d{0,7}d)$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

const bytes = (value: string) => encoder.encode(value).length;
function invalid(): never { throw new Error('Invalid insights dashboard data.'); }

/** Returns the day count for a range ID, or undefined for all time. */
export function insightsRangeDays(id: string): number | undefined {
  if (!RANGE_ID.test(id)) invalid();
  return id === 'all' ? undefined : Number(id.slice(0, -1));
}

export function insightsRangeLabel(id: string): string {
  const days = insightsRangeDays(id);
  return days === undefined ? 'All time' : days === 1 ? 'Last 24 hours' : `Last ${days} days`;
}

/** Turns untrusted session-derived text into one bounded display line. */
export function insightsText(value: string, maxBytes = INSIGHTS_TEXT_BYTES): string {
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

export function encodeInsightsDashboard(dashboard: InsightsDashboard): UiValues | undefined {
  const encoded = JSON.stringify(parseInsightsDashboard(dashboard));
  return bytes(encoded) > INSIGHTS_DASHBOARD_BYTES ? undefined : { dashboard: encoded };
}

export function readInsightsDashboard(data: UiValues | undefined): InsightsDashboard {
  const encoded = data?.dashboard;
  if (typeof encoded !== 'string' || bytes(encoded) > INSIGHTS_DASHBOARD_BYTES) invalid();
  let value: unknown;
  try { value = JSON.parse(encoded); } catch { invalid(); }
  return parseInsightsDashboard(value);
}

export function parseInsightsDashboard(value: unknown): InsightsDashboard {
  const source = record(value, ['generatedAt', 'range', 'loadedSessions', 'totals', 'daily', 'hourly', 'tools', 'models',
    'projects', 'thinkingLevels', 'stopReasons', 'rage', 'sessions'], ['reportPath', 'notice']);
  const range = record(source.range, ['id', 'label', 'to'], ['from']);
  const id = text(range.id);
  insightsRangeDays(id);
  const totals = record(source.totals, ['sessions', 'messages', 'userMessages', 'tokens', 'cost', 'durationMinutes',
    'avgSessionMinutes', 'avgMessagesPerSession', 'multiModelSessions']);
  const daily = list(source.daily, entry => {
    const row = record(entry, ['date', 'sessions', 'messages', 'tokens', 'cost']);
    return { date: day(row.date), sessions: count(row.sessions), messages: count(row.messages), tokens: amount(row.tokens), cost: amount(row.cost) };
  });
  if (daily.some((row, index) => index > 0 && row.date <= daily[index - 1].date)) invalid();
  const rage = record(source.rage, ['total', 'messagesWithSwears', 'byModel', 'byHour', 'byProject', 'topWords']);
  const sessions = record(source.sessions, ['query', 'page', 'pageCount', 'matched', 'rows']);
  const rows = list(sessions.rows, entry => {
    const row = record(entry, ['start', 'project', 'messages', 'tokens', 'durationMinutes', 'cost', 'models']);
    return {
      start: instant(row.start), project: text(row.project), messages: count(row.messages), tokens: amount(row.tokens),
      durationMinutes: amount(row.durationMinutes), cost: amount(row.cost), models: list(row.models, model => text(model)),
    };
  });
  const dashboard: InsightsDashboard = {
    generatedAt: instant(source.generatedAt),
    range: { id, label: text(range.label), ...(range.from === undefined ? {} : { from: instant(range.from) }), to: instant(range.to) },
    loadedSessions: count(source.loadedSessions),
    ...(source.reportPath === undefined ? {} : { reportPath: text(source.reportPath, PATH_BYTES) }),
    ...(source.notice === undefined ? {} : { notice: notice(source.notice) }),
    totals: {
      sessions: count(totals.sessions), messages: count(totals.messages), userMessages: count(totals.userMessages),
      tokens: amount(totals.tokens), cost: amount(totals.cost), durationMinutes: amount(totals.durationMinutes),
      avgSessionMinutes: amount(totals.avgSessionMinutes), avgMessagesPerSession: amount(totals.avgMessagesPerSession),
      multiModelSessions: count(totals.multiModelSessions),
    },
    daily,
    hourly: list(source.hourly, count, 24),
    tools: list(source.tools, named),
    models: list(source.models, entry => {
      const row = record(entry, ['name', 'sessions', 'messages', 'tokens', 'cost', 'avgSessionMinutes', 'toolErrorsPerSession']);
      return {
        name: text(row.name), sessions: count(row.sessions), messages: count(row.messages), tokens: amount(row.tokens),
        cost: amount(row.cost), avgSessionMinutes: amount(row.avgSessionMinutes), toolErrorsPerSession: amount(row.toolErrorsPerSession),
      };
    }),
    projects: list(source.projects, entry => {
      const row = record(entry, ['name', 'sessions', 'messages', 'tokens', 'cost', 'durationMinutes']);
      return {
        name: text(row.name), sessions: count(row.sessions), messages: count(row.messages), tokens: amount(row.tokens),
        cost: amount(row.cost), durationMinutes: amount(row.durationMinutes),
      };
    }),
    thinkingLevels: list(source.thinkingLevels, named),
    stopReasons: list(source.stopReasons, named),
    rage: {
      total: count(rage.total), messagesWithSwears: count(rage.messagesWithSwears), byModel: list(rage.byModel, named),
      byHour: list(rage.byHour, count, 24), byProject: list(rage.byProject, named),
      topWords: list(rage.topWords, entry => {
        const word = record(entry, ['word', 'group', 'count']);
        return { word: text(word.word), group: text(word.group), count: count(word.count) };
      }),
    },
    sessions: {
      query: text(sessions.query, INSIGHTS_QUERY_BYTES), page: count(sessions.page), pageCount: count(sessions.pageCount),
      matched: count(sessions.matched), rows,
    },
  };
  const page = dashboard.sessions;
  if (dashboard.totals.sessions > dashboard.loadedSessions || page.matched > dashboard.totals.sessions
    || page.pageCount !== Math.max(1, Math.ceil(page.matched / INSIGHTS_SESSIONS_PAGE_SIZE)) || page.page >= page.pageCount
    || rows.length !== Math.min(INSIGHTS_SESSIONS_PAGE_SIZE, page.matched - page.page * INSIGHTS_SESSIONS_PAGE_SIZE)) invalid();
  return dashboard;
}

function notice(value: unknown): NonNullable<InsightsDashboard['notice']> {
  const source = record(value, ['level', 'text']);
  if (source.level !== 'info' && source.level !== 'warning') invalid();
  return { level: source.level, text: text(source.text, INSIGHTS_NOTICE_BYTES) };
}

function named(value: unknown): InsightsCount {
  const source = record(value, ['name', 'count']);
  return { name: text(source.name), count: count(source.count) };
}

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
  if (Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) invalid();
  return value as Record<string, unknown>;
}

function list<T>(value: unknown, item: (entry: unknown) => T, length?: number): T[] {
  if (!Array.isArray(value) || length !== undefined && value.length !== length) invalid();
  return value.map(entry => item(entry));
}

function text(value: unknown, maxBytes = INSIGHTS_TEXT_BYTES): string {
  if (typeof value !== 'string' || bytes(value) > maxBytes || CONTROL.test(value) || LONE_SURROGATE.test(value)) invalid();
  return value;
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

function amount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid();
  return value;
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
