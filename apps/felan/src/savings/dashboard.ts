import { createHash } from 'node:crypto';
import type { UiValues } from '@felan-ai/agent-core';
import type { SavingsBucket, SavingsOutcomeTotals } from '../providers/savings.js';
import {
  SAVINGS_CATEGORIES, SAVINGS_DEFAULT_RANGE, SAVINGS_RANGES,
  encodeSavingsDashboard, formatSavingsTokenImpact, formatSavingsTokens, formatSavingsUsd, savingsCategoryLabel, savingsRangeDays, savingsRangeLabel, savingsText,
  type SavingsAmount, type SavingsBasisKind, type SavingsCategoryId, type SavingsDashboard, type SavingsRangeId, type SavingsRangeView,
  type SavingsSessionInfo, type SavingsShare, type SavingsTabId, type SavingsUnpriced,
} from './data.js';

export interface SavingsSessionLabel { readonly title: string; readonly cwd: string }

export interface SavingsDashboardInput {
  readonly buckets: readonly SavingsBucket[];
  readonly diagnostics: readonly string[];
  readonly now: Date;
  readonly currentSessionId: string;
  readonly currentProjectKey: string;
  /** Labels the current project even before its session appears in the history list. */
  readonly currentProjectCwd?: string;
  readonly sessions: ReadonlyMap<string, SavingsSessionLabel>;
  readonly initialRange?: SavingsRangeId;
  readonly initialTab?: SavingsTabId;
}

const EXTENSION_LABELS: Readonly<Record<string, string>> = {
  '@felan-ai/agent-core/dynamic-thinking': 'Dynamic thinking',
  '@felan-ai/ext-markitdown': 'MarkItDown',
  '@felan-ai/ext-output-style': 'Output style',
  '@felan-ai/ext-prewalk': 'Prewalk',
  '@felan-ai/ext-rtk-optimizer': 'RTK optimizer',
  '@felan-ai/ext-subagents': 'Subagents',
};

/** The dashboard before session rows are indexed, so trimming can drop rows by session ID. */
type Model = Omit<SavingsDashboard, 'sessions' | 'ranges' | 'currentSession'> & {
  sessions: Map<string, SavingsSessionInfo>;
  ranges: Array<Omit<SavingsRangeView, 'sessions'> & { sessions: Array<SavingsShare & { id: string }> }>;
  currentSessionId: string;
};

/** Data is omitted when even a trimmed dashboard exceeds the budget. */
export function createSavingsDashboard(input: SavingsDashboardInput): { dashboard: SavingsDashboard; data?: UiValues } {
  const model = buildModel(input);
  for (;;) {
    const dashboard = layout(model);
    const data = encodeSavingsDashboard(dashboard);
    if (data) return { dashboard, data };
    const widest = model.ranges.reduce((best, range) => range.sessions.length > best.sessions.length ? range : best);
    if (!widest.sessions.length) return { dashboard };
    const drop = Math.max(1, Math.ceil(widest.sessions.length / 5));
    widest.sessions.splice(-drop);
    widest.omittedSessions += drop;
  }
}

export function savingsDashboardMarkdown(dashboard: SavingsDashboard): string {
  const range = dashboard.ranges.find(view => view.id === dashboard.initialRange)!;
  const extension = (index: number) => dashboard.extensions[index]!;
  const lines = [
    `# Estimated savings — ${range.label}`, '',
    `Estimated API-equivalent cost avoided: **${formatSavingsUsd(range.totals.savedUsd)}** (baseline ${formatSavingsUsd(range.totals.baselineUsd)}, actual ${formatSavingsUsd(range.totals.actualUsd)})`,
    `Measured optimization decisions: ${range.totals.decisions} · Token impact: ${formatSavingsTokenImpact(range.totals.savedTokens)}`,
    `This session: ${formatSavingsUsd(range.currentSession.savedUsd)} · This project: ${formatSavingsUsd(range.currentProject.savedUsd)}`,
  ];
  if (range.unpriced.decisions) lines.push(`${range.unpriced.decisions} decisions without a price are excluded from USD totals (${formatSavingsTokenImpact(range.unpriced.savedTokens)}).`);
  if (range.categories.length) {
    lines.push('', '| Category | Decisions | Saved |', '| --- | ---: | ---: |',
      ...range.categories.map(row => `| ${savingsCategoryLabel(row.category)} | ${row.decisions} | ${formatSavingsUsd(row.savedUsd)} |`));
  }
  if (range.extensions.length) {
    lines.push('', '| Extension | Category | Decisions | Tokens saved | Saved |', '| --- | --- | ---: | ---: | ---: |',
      ...range.extensions.map(row => `| ${markdownCell(extension(row.extension).label)} | ${savingsCategoryLabel(extension(row.extension).category)} | ${row.decisions} | ${formatSavingsTokens(row.savedTokens)} | ${formatSavingsUsd(row.savedUsd)} |`));
  }
  if (range.sessions.length) {
    lines.push('', '| Session | Project | Decisions | Saved |', '| --- | --- | ---: | ---: |',
      ...range.sessions.map(row => {
        const session = dashboard.sessions[row.session]!;
        return `| ${markdownCell(session.title)} | ${markdownCell(dashboard.projects[session.project]!.label)} | ${row.decisions} | ${formatSavingsUsd(row.savedUsd)} |`;
      }));
    if (range.omittedSessions) lines.push('', `${range.omittedSessions} smaller sessions are not listed.`);
  }
  lines.push('', 'Values are API-equivalent estimates priced from the model catalog when each decision was measured. Days are UTC.');
  if (dashboard.firstDay) lines.push(`Measurements retained since ${dashboard.firstDay}.`);
  lines.push(...dashboard.diagnostics.map(diagnostic => `Warning: ${diagnostic}`));
  return lines.join('\n');
}

function buildModel(input: SavingsDashboardInput): Model {
  const today = input.now.toISOString().slice(0, 10);
  const projectLabels = new Map<string, string>();
  for (const session of input.sessions.values()) {
    projectLabels.set(createHash('sha256').update(session.cwd).digest('hex'), savingsText(basename(session.cwd) || session.cwd || 'Unknown project'));
  }
  if (input.currentProjectCwd && !projectLabels.has(input.currentProjectKey)) {
    projectLabels.set(input.currentProjectKey, savingsText(basename(input.currentProjectCwd) || input.currentProjectCwd));
  }
  const projectLabel = (key: string) => projectLabels.get(key) ?? `Project ${key.slice(0, 8)}`;
  const days = input.buckets.map(bucket => bucket.day).sort();
  const extensionIds = [...new Set(input.buckets.map(bucket => bucket.producerId))]
    .sort((left, right) => extensionLabel(left).localeCompare(extensionLabel(right)) || left.localeCompare(right));
  const extensions = extensionIds.map(id => ({ id: savingsText(id), label: savingsText(extensionLabel(id)), category: dominantCategory(input.buckets.filter(bucket => bucket.producerId === id)) }));
  const extensionIndex = new Map(extensionIds.map((id, index) => [id, index]));
  const projectKeys = [...new Set([...input.buckets.map(bucket => bucket.projectKey), input.currentProjectKey])]
    .sort((left, right) => projectLabel(left).localeCompare(projectLabel(right)) || left.localeCompare(right));
  const projectIndex = new Map(projectKeys.map((key, index) => [key, index]));
  const sessions = new Map<string, SavingsSessionInfo>();
  const bySession = groupBy(input.buckets, bucket => bucket.sessionId);
  for (const id of new Set([...bySession.keys(), input.currentSessionId])) {
    const own = (bySession.get(id) ?? []).slice().sort((left, right) => left.day.localeCompare(right.day));
    const latest = own.at(-1);
    sessions.set(id, {
      id: savingsText(id),
      title: savingsText(input.sessions.get(id)?.title || `Session ${id.slice(0, 8)}`),
      project: projectIndex.get(latest?.projectKey ?? input.currentProjectKey)!,
      lastDay: latest?.day ?? today,
      extensions: [...groupBy(own, bucket => bucket.producerId)].map(([producer, rows]) => ({ ...shareOf(rows), extension: extensionIndex.get(producer)! }))
        .sort((left, right) => right.savedUsd - left.savedUsd || left.extension - right.extension),
    });
  }
  return {
    generatedAt: input.now.toISOString(),
    ...(days.length ? { firstDay: days[0]!, lastDay: days.at(-1)! } : {}),
    initialRange: input.initialRange ?? SAVINGS_DEFAULT_RANGE,
    initialTab: input.initialTab ?? 'overview',
    currentSessionId: input.currentSessionId,
    currentProject: projectIndex.get(input.currentProjectKey)!,
    extensions,
    projects: projectKeys.map(key => ({ label: projectLabel(key) })),
    sessions,
    ranges: SAVINGS_RANGES.map(id => rangeModel(id, input, today, days[0], extensionIndex, projectIndex)),
    diagnostics: input.diagnostics.map(diagnostic => savingsText(diagnostic)),
  };
}

function rangeModel(id: SavingsRangeId, input: SavingsDashboardInput, to: string, firstDay: string | undefined,
  extensionIndex: ReadonlyMap<string, number>, projectIndex: ReadonlyMap<string, number>): Model['ranges'][number] {
  const length = savingsRangeDays(id);
  const from = length === undefined ? undefined : addDays(to, 1 - length);
  const buckets = input.buckets.filter(bucket => (id !== 'session' || bucket.sessionId === input.currentSessionId)
    && (from === undefined || bucket.day >= from && bucket.day <= to));
  const trendStart = id === 'session' ? buckets.map(bucket => bucket.day).sort()[0] : firstDay;
  const periods = from === undefined
    ? months(trendStart?.slice(0, 7) ?? to.slice(0, 7), to.slice(0, 7))
    : Array.from({ length: length! }, (_, offset) => addDays(from, offset));
  const byPeriod = groupBy(buckets, bucket => from === undefined ? bucket.day.slice(0, 7) : bucket.day);
  return {
    id, label: savingsRangeLabel(id), ...(from === undefined ? {} : { from }), to,
    totals: amountOf(buckets),
    unpriced: unpricedOf(buckets),
    currentSession: amountOf(buckets.filter(bucket => bucket.sessionId === input.currentSessionId)),
    currentProject: amountOf(buckets.filter(bucket => bucket.projectKey === input.currentProjectKey)),
    categories: SAVINGS_CATEGORIES.flatMap(category => {
      const rows = buckets.filter(bucket => bucket.category === category);
      return rows.length ? [{ ...amountOf(rows), category }] : [];
    }),
    extensions: ranked([...groupBy(buckets, bucket => bucket.producerId)].map(([producer, rows]) => ({
      ...amountOf(rows), extension: extensionIndex.get(producer)!,
      operations: ranked([...groupBy(rows, bucket => JSON.stringify([bucket.operation ?? '', bucket.basis.kind, bucket.basis.method]))].map(([key, group]) => {
        const [operation, basis, method] = JSON.parse(key) as [string, SavingsBasisKind, string];
        return { ...amountOf(group), operation: savingsText(operation || 'unspecified'), basis, method: savingsText(method) };
      })),
    }))),
    sessions: ranked([...groupBy(buckets, bucket => bucket.sessionId)].map(([session, rows]) => ({ ...shareOf(rows), id: session }))),
    projects: ranked([...groupBy(buckets, bucket => bucket.projectKey)].map(([project, rows]) => ({
      ...amountOf(rows), project: projectIndex.get(project)!, sessions: new Set(rows.map(bucket => bucket.sessionId)).size,
    }))),
    trend: { granularity: from === undefined ? 'month' : 'day', points: periods.map(period => ({ ...amountOf(byPeriod.get(period) ?? []), period })) },
    omittedSessions: 0,
  };
}

function layout(model: Model): SavingsDashboard {
  const referenced = new Set([model.currentSessionId, ...model.ranges.flatMap(range => range.sessions.map(row => row.id))]);
  const ids = [...model.sessions.keys()].filter(id => referenced.has(id))
    .sort((left, right) => model.sessions.get(right)!.lastDay.localeCompare(model.sessions.get(left)!.lastDay) || left.localeCompare(right));
  const sessionIndex = new Map(ids.map((id, index) => [id, index]));
  const { currentSessionId, sessions, ranges, ...rest } = model;
  return {
    ...rest,
    currentSession: sessionIndex.get(currentSessionId)!,
    sessions: ids.map(id => sessions.get(id)!),
    ranges: ranges.map(range => ({ ...range, sessions: range.sessions.map(({ id, ...amount }) => ({ ...amount, session: sessionIndex.get(id)! })) })),
  };
}

function amountOf(buckets: readonly SavingsBucket[]): SavingsAmount {
  let savedUsd = 0; let baselineUsd = 0; let actualUsd = 0; let decisions = 0; let savedTokens = 0;
  for (const bucket of buckets) {
    if (!priced(bucket)) continue;
    baselineUsd += bucket.baseline.costUsd!; actualUsd += bucket.actual.costUsd!;
    savedUsd += bucket.baseline.costUsd! - bucket.actual.costUsd!;
    decisions += bucket.calls; savedTokens += tokenDelta(bucket);
  }
  return { savedUsd: usd(savedUsd), baselineUsd: usd(baselineUsd), actualUsd: usd(actualUsd), decisions, savedTokens };
}

function shareOf(buckets: readonly SavingsBucket[]): SavingsShare {
  const { savedUsd, decisions, savedTokens } = amountOf(buckets);
  return { savedUsd, decisions, savedTokens };
}

function unpricedOf(buckets: readonly SavingsBucket[]): SavingsUnpriced {
  const rows = buckets.filter(bucket => !priced(bucket));
  return { decisions: rows.reduce((sum, bucket) => sum + bucket.calls, 0), savedTokens: rows.reduce((sum, bucket) => sum + tokenDelta(bucket), 0) };
}

function priced(bucket: SavingsBucket): boolean { return bucket.baseline.costUsd !== undefined && bucket.actual.costUsd !== undefined; }

/** Token impact is only known when both sides report usage; cache writes are part of `cacheWrite`. */
function tokenDelta(bucket: SavingsBucket): number {
  const total = (outcome: SavingsOutcomeTotals) => outcome.tokens
    ? outcome.tokens.input + outcome.tokens.output + outcome.tokens.cacheRead + outcome.tokens.cacheWrite : undefined;
  const baseline = total(bucket.baseline);
  const actual = total(bucket.actual);
  return baseline === undefined || actual === undefined ? 0 : baseline - actual;
}

function ranked<T extends SavingsShare>(rows: T[]): T[] {
  return rows.sort((left, right) => right.savedUsd - left.savedUsd || right.decisions - left.decisions);
}

function dominantCategory(buckets: readonly SavingsBucket[]): SavingsCategoryId {
  const counts = new Map<SavingsCategoryId, number>();
  for (const bucket of buckets) counts.set(bucket.category, (counts.get(bucket.category) ?? 0) + bucket.calls);
  return [...counts].sort((left, right) => right[1] - left[1] || SAVINGS_CATEGORIES.indexOf(left[0]) - SAVINGS_CATEGORIES.indexOf(right[0]))[0]![0];
}

function extensionLabel(id: string): string { return EXTENSION_LABELS[id] ?? id; }

function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const name = key(value);
    const group = groups.get(name);
    if (group) group.push(value); else groups.set(name, [value]);
  }
  return groups;
}

function addDays(day: string, offset: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + offset * 86_400_000).toISOString().slice(0, 10);
}

function months(first: string, last: string): string[] {
  const result: string[] = [];
  for (let [year, month] = first.split('-').map(Number) as [number, number]; `${year}-${String(month).padStart(2, '0')}` <= last;) {
    result.push(`${year}-${String(month).padStart(2, '0')}`);
    if (month === 12) { year += 1; month = 1; } else month += 1;
  }
  return result;
}

function basename(path: string): string { return path.split(/[\\/]+/u).filter(Boolean).at(-1) ?? ''; }
function usd(value: number): number { return Math.round(value * 1e6) / 1e6; }
function markdownCell(value: string): string { return value.replaceAll('\\', '\\\\').replaceAll('|', '\\|'); }
