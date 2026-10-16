import { computeAnalytics } from './analytics.js';
import { mergeParsedSessions } from './parser.js';
import type { InsightsLoadedSession, InsightsReport } from './contracts.js';
import {
  INSIGHTS_QUERY_BYTES, INSIGHTS_RANGE_PRESETS, INSIGHTS_SESSIONS_PAGE_SIZE, insightsRangeDays, insightsRangeLabel, insightsText,
  type InsightsDashboard, type InsightsSessionRow,
} from './data.js';
import { sliceParsedSession } from './slicing.js';
import type { ParsedSession } from './types.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface InsightsView {
  readonly range: string;
  readonly query: string;
  readonly page: number;
  readonly notice?: InsightsDashboard['notice'];
}

export function insightsRangeOptions(initialRange: string): string[] {
  const ids = [...new Set([...INSIGHTS_RANGE_PRESETS, initialRange])];
  return ids.sort((left, right) => (insightsRangeDays(left) ?? Infinity) - (insightsRangeDays(right) ?? Infinity));
}

/** Root sessions for a range. Every part is a fresh slice because merging mutates its inputs. */
export function sessionsForRange(loaded: readonly InsightsLoadedSession[], range: string, generatedAt: Date): ParsedSession[] {
  const days = insightsRangeDays(range);
  const start = days === undefined ? undefined : new Date(generatedAt.getTime() - days * MS_PER_DAY);
  const groups = new Map<string, ParsedSession[]>();
  for (const { rootId, session } of loaded) {
    const part = sliceParsedSession(session, start, generatedAt);
    if (!part) continue;
    groups.set(rootId, [...(groups.get(rootId) ?? []), part]);
  }
  return [...groups].flatMap(([rootId, parts]) => {
    const merged = mergeParsedSessions(parts, rootId);
    return merged ? [merged] : [];
  });
}

export function buildInsightsDashboard(report: InsightsReport, view: InsightsView): InsightsDashboard {
  const generatedAt = report.generatedAt;
  const analytics = computeAnalytics(sessionsForRange(report.loaded, view.range, generatedAt));
  const days = insightsRangeDays(view.range);
  const query = insightsText(view.query, INSIGHTS_QUERY_BYTES);
  const needle = query.toLowerCase();
  const matches = [...analytics.sessions].reverse().filter(session => !needle
    || [session.projectName, session.startTime, ...Object.keys(session.models)].some(value => value.toLowerCase().includes(needle)));
  const pageCount = Math.max(1, Math.ceil(matches.length / INSIGHTS_SESSIONS_PAGE_SIZE));
  const page = Math.min(Math.max(0, view.page), pageCount - 1);
  const rows: InsightsSessionRow[] = matches.slice(page * INSIGHTS_SESSIONS_PAGE_SIZE, (page + 1) * INSIGHTS_SESSIONS_PAGE_SIZE).map(session => ({
    start: session.startTime,
    project: insightsText(session.projectName),
    messages: session.messageCount,
    tokens: session.tokenUsage.total,
    durationMinutes: session.duration,
    cost: session.cost.total,
    models: Object.keys(session.models).map(model => insightsText(model)),
  }));
  const named = (entries: Array<{ name: string; count: number }>) => entries.map(entry => ({ name: insightsText(entry.name), count: entry.count }));
  return {
    generatedAt: generatedAt.toISOString(),
    range: {
      id: view.range, label: insightsRangeLabel(view.range),
      ...(days === undefined ? {} : { from: new Date(generatedAt.getTime() - days * MS_PER_DAY).toISOString() }),
      to: generatedAt.toISOString(),
    },
    loadedSessions: new Set(report.loaded.map(entry => entry.rootId)).size,
    reportPath: report.path,
    ...(view.notice === undefined ? {} : { notice: view.notice }),
    totals: {
      sessions: analytics.totalSessions, messages: analytics.totalMessages,
      userMessages: analytics.sessions.reduce((sum, session) => sum + session.userMessageCount, 0),
      tokens: analytics.totalTokens, cost: analytics.totalCost, durationMinutes: analytics.totalDuration,
      avgSessionMinutes: analytics.avgSessionDuration, avgMessagesPerSession: analytics.avgMessagesPerSession,
      multiModelSessions: analytics.modelSwitchCount,
    },
    daily: analytics.dailyStats.map(row => ({ date: row.date, sessions: row.sessions, messages: row.messages, tokens: row.tokens, cost: row.cost })),
    hourly: analytics.hourlyDistribution.map(entry => entry.count),
    tools: named(analytics.topTools),
    models: (analytics.modelEfficiency?.models ?? []).map(model => ({
      name: insightsText(model.model), sessions: model.sessions, messages: model.messages, tokens: model.tokens, cost: model.cost,
      avgSessionMinutes: model.avgSessionDuration, toolErrorsPerSession: model.toolErrorRate ?? 0,
    })),
    projects: analytics.projectStats.map(project => ({
      name: insightsText(project.name), sessions: project.sessions, messages: project.messages, tokens: project.tokens,
      cost: project.cost, durationMinutes: project.duration,
    })),
    thinkingLevels: named(analytics.thinkingLevelDistribution),
    stopReasons: named(analytics.stopReasonDistribution),
    rage: {
      total: analytics.rageStats.total, messagesWithSwears: analytics.rageStats.messagesWithSwears,
      byModel: named(analytics.rageStats.byModel), byHour: analytics.rageStats.byHour.map(entry => entry.count),
      byProject: named(analytics.rageStats.byProject),
      topWords: analytics.rageStats.topWords.map(entry => ({ word: insightsText(entry.word), group: insightsText(entry.group), count: entry.count })),
    },
    sessions: { query, page, pageCount, matched: matches.length, rows },
  };
}
