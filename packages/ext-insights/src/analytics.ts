import type {
  ParsedSession,
  Analytics,
  DailyStats,
  ProjectStats,
  ModelStats,
  RageStats,
  TemporalInsights,
  ModelEfficiencySummary,
  InsightFlag,
  InsightRecommendation,
  DeterministicAnalysis,
} from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DECAY_HALF_LIFE_DAYS = 10;

export function computeAnalytics(sessions: ParsedSession[]): Analytics {
  if (sessions.length === 0) {
    return emptyAnalytics();
  }

  const sorted = [...sessions].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  const totalSessions = sorted.length;
  const totalMessages = sorted.reduce((s, sess) => s + sess.messageCount, 0);
  const totalTokens = sorted.reduce((s, sess) => s + sess.tokenUsage.total, 0);
  const totalCost = sorted.reduce((s, sess) => s + sess.cost.total, 0);
  const totalDuration = sorted.reduce((s, sess) => s + sess.duration, 0);

  const startDate = sorted[0].startTime;
  const endDate = sorted[sorted.length - 1].endTime;

  // Daily stats
  const dailyMap = new Map<string, DailyStats>();
  for (const sess of sorted) {
    const date = sess.startTime.toISOString().split("T")[0];
    const existing = dailyMap.get(date);
    if (existing) {
      existing.sessions++;
      existing.messages += sess.messageCount;
      existing.tokens += sess.tokenUsage.total;
      existing.cost += sess.cost.total;
    } else {
      dailyMap.set(date, {
        date,
        sessions: 1,
        messages: sess.messageCount,
        tokens: sess.tokenUsage.total,
        cost: sess.cost.total,
      });
    }
  }
  const dailyStats = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  // Project stats
  const projectMap = new Map<string, ProjectStats>();
  for (const sess of sorted) {
    const existing = projectMap.get(sess.projectName);
    if (existing) {
      existing.sessions++;
      existing.messages += sess.messageCount;
      existing.tokens += sess.tokenUsage.total;
      existing.cost += sess.cost.total;
      existing.duration += sess.duration;
    } else {
      projectMap.set(sess.projectName, {
        name: sess.projectName,
        sessions: 1,
        messages: sess.messageCount,
        tokens: sess.tokenUsage.total,
        cost: sess.cost.total,
        duration: sess.duration,
      });
    }
  }
  const projectStats = Array.from(projectMap.values()).sort((a, b) => b.messages - a.messages);

  // Model stats
  const modelMap = new Map<string, ModelStats>();
  let modelSwitchCount = 0;
  for (const sess of sorted) {
    const sessModels = Object.keys(sess.models);
    if (sessModels.length > 1) modelSwitchCount++;

    for (const [name, stats] of Object.entries(sess.models)) {
      const existing = modelMap.get(name);
      if (existing) {
        existing.count += stats.count;
        existing.tokens += stats.tokens;
        existing.cost += stats.cost;
      } else {
        modelMap.set(name, { name, count: stats.count, tokens: stats.tokens, cost: stats.cost, avgDuration: 0 });
      }
    }
  }
  // Only include models that actually generated tokens (filters model_change-only entries)
  const modelStats = Array.from(modelMap.values())
    .filter(m => m.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);

  // Tool usage
  const toolMap = new Map<string, number>();
  for (const sess of sorted) {
    for (const [tool, count] of Object.entries(sess.toolUsage)) {
      toolMap.set(tool, (toolMap.get(tool) ?? 0) + count);
    }
  }
  const topTools = Array.from(toolMap.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Thinking levels
  const thinkingMap = new Map<string, number>();
  for (const sess of sorted) {
    for (const [level, count] of Object.entries(sess.thinkingLevels)) {
      thinkingMap.set(level, (thinkingMap.get(level) ?? 0) + count);
    }
  }
  const thinkingLevelDistribution = Array.from(thinkingMap.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  // Stop reasons
  const stopMap = new Map<string, number>();
  for (const sess of sorted) {
    for (const [reason, count] of Object.entries(sess.stopReasons)) {
      stopMap.set(reason, (stopMap.get(reason) ?? 0) + count);
    }
  }
  const stopReasonDistribution = Array.from(stopMap.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  // Hourly distribution (session start hours)
  const hourlyMap = new Map<number, number>();
  for (let i = 0; i < 24; i++) hourlyMap.set(i, 0);
  for (const sess of sorted) {
    const hour = sess.startTime.getHours();
    hourlyMap.set(hour, (hourlyMap.get(hour) ?? 0) + 1);
  }
  const hourlyDistribution = Array.from(hourlyMap.entries())
    .map(([hour, count]) => ({ hour, count }))
    .sort((a, b) => a.hour - b.hour);

  // Rage stats
  const rageByModel = new Map<string, number>();
  const rageByHour = new Map<number, number>();
  const rageByProject = new Map<string, number>();
  const rageByWord = new Map<string, { group: string; count: number }>();
  let rageTotalHits = 0;
  let rageMsgsWithSwears = 0;

  for (const sess of sorted) {
    const seenMsgKeys = new Set<string>();
    for (const hit of sess.rageHits) {
      rageTotalHits++;
      const msgKey = `${sess.id}-${hit.msgIndex}`;
      if (!seenMsgKeys.has(msgKey)) {
        rageMsgsWithSwears++;
        seenMsgKeys.add(msgKey);
      }
      rageByModel.set(hit.model, (rageByModel.get(hit.model) ?? 0) + 1);
      if (hit.hour >= 0) rageByHour.set(hit.hour, (rageByHour.get(hit.hour) ?? 0) + 1);
      rageByProject.set(sess.projectName, (rageByProject.get(sess.projectName) ?? 0) + 1);
      const existing = rageByWord.get(hit.word);
      if (existing) { existing.count++; }
      else { rageByWord.set(hit.word, { group: hit.group, count: 1 }); }
    }
  }

  const rageStats: RageStats = {
    total: rageTotalHits,
    messagesWithSwears: rageMsgsWithSwears,
    byModel: Array.from(rageByModel.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    byHour: Array.from({ length: 24 }, (_, h) => ({ hour: h, count: rageByHour.get(h) ?? 0 })),
    byProject: Array.from(rageByProject.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    topWords: Array.from(rageByWord.entries())
      .map(([word, { group, count }]) => ({ word, group, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20),
  };

  const temporal = computeTemporalInsights(sorted);
  const modelEfficiency = computeModelEfficiency(sorted);
  const analysis = computeDeterministicAnalysis(
    sorted,
    projectStats,
    modelStats,
    modelSwitchCount,
    rageStats,
    temporal,
    modelEfficiency
  );

  return {
    totalSessions,
    totalMessages,
    totalTokens,
    totalCost,
    totalDuration,
    avgSessionDuration: Math.round(totalDuration / totalSessions),
    avgMessagesPerSession: Math.round(totalMessages / totalSessions),
    dateRange: {
      start: startDate.toISOString().split("T")[0],
      end: endDate.toISOString().split("T")[0],
    },
    dailyStats,
    projectStats,
    modelStats,
    topTools,
    thinkingLevelDistribution,
    stopReasonDistribution,
    hourlyDistribution,
    modelSwitchCount,
    rageStats,
    temporal,
    modelEfficiency,
    analysis,
    sessions: sorted.map(s => ({
      id: s.id,
      cwd: s.cwd,
      projectName: s.projectName,
      startTime: s.startTime.toISOString(),
      endTime: s.endTime.toISOString(),
      duration: s.duration,
      messageCount: s.messageCount,
      userMessageCount: s.userMessageCount,
      assistantMessageCount: s.assistantMessageCount,
      toolCallCount: s.toolCallCount,
      tokenUsage: s.tokenUsage,
      cost: s.cost,
      models: s.models,
      providers: s.providers,
      thinkingLevels: s.thinkingLevels,
      toolUsage: s.toolUsage,
      stopReasons: s.stopReasons,
      toolCallErrors: s.toolCallErrors,
      hasError: s.hasError,
      rageHits: s.rageHits,
      metadata: s.metadata,
    })),
  };
}

function computeTemporalInsights(sorted: ParsedSession[]): TemporalInsights {
  const end = sorted[sorted.length - 1].endTime;
  const currentStart = new Date(end.getTime() - 7 * MS_PER_DAY);
  const previousStart = new Date(end.getTime() - 14 * MS_PER_DAY);
  const current = sorted.filter(sess => sess.startTime >= currentStart && sess.startTime <= end);
  const previous = sorted.filter(sess => sess.startTime >= previousStart && sess.startTime < currentStart);
  const currentTotals = summarizeSessions(current);
  const previousTotals = summarizeSessions(previous);

  return {
    generatedAt: new Date().toISOString(),
    decayHalfLifeDays: DECAY_HALF_LIFE_DAYS,
    decayWeightedActivity: computeDecayWeightedActivity(sorted, end),
    weekOverWeek: {
      currentStart: currentStart.toISOString().split("T")[0],
      previousStart: previousStart.toISOString().split("T")[0],
      sessionsDelta: currentTotals.sessions - previousTotals.sessions,
      costDelta: currentTotals.cost - previousTotals.cost,
      toolErrorDelta: currentTotals.toolErrors - previousTotals.toolErrors,
    },
    trajectory: {
      cost: compareTrend(currentTotals.cost, previousTotals.cost, true),
      errors: compareTrend(currentTotals.toolErrors, previousTotals.toolErrors, true),
    },
    anomalies: detectAnomalies(sorted),
    deterministicFriction: computeDeterministicFriction(currentTotals, previousTotals),
  };
}

function computeModelEfficiency(sorted: ParsedSession[]): ModelEfficiencySummary {
  const modelMap = new Map<string, {
    tokens: number;
    cost: number;
    messages: number;
    sessions: number;
    duration: number;
    toolErrors: number;
  }>();

  for (const sess of sorted) {
    for (const [model, stats] of Object.entries(sess.models)) {
      if (stats.tokens <= 0) continue;
      const existing = modelMap.get(model) ?? { tokens: 0, cost: 0, messages: 0, sessions: 0, duration: 0, toolErrors: 0 };
      existing.tokens += stats.tokens;
      existing.cost += stats.cost;
      existing.messages += stats.count;
      existing.sessions += 1;
      existing.duration += sess.duration;
      existing.toolErrors += sess.toolCallErrors;
      modelMap.set(model, existing);
    }
  }

  const models = Array.from(modelMap.entries()).map(([model, stats]) => ({
    model,
    tokens: stats.tokens,
    cost: stats.cost,
    costPerToken: stats.tokens > 0 ? stats.cost / stats.tokens : 0,
    costPerMessage: stats.messages > 0 ? stats.cost / stats.messages : 0,
    messages: stats.messages,
    sessions: stats.sessions,
    avgSessionDuration: stats.sessions > 0 ? Math.round(stats.duration / stats.sessions) : 0,
    toolErrorRate: stats.sessions > 0 ? stats.toolErrors / stats.sessions : 0,
  })).sort((a, b) => b.cost - a.cost);

  return {
    generatedAt: new Date().toISOString(),
    models,
    recommendations: modelEfficiencyRecommendations(models),
  };
}

function computeDeterministicAnalysis(
  sorted: ParsedSession[],
  projectStats: ProjectStats[],
  modelStats: ModelStats[],
  modelSwitchCount: number,
  rageStats: RageStats,
  temporal: TemporalInsights,
  modelEfficiency: ModelEfficiencySummary
): DeterministicAnalysis {
  const totalSessions = sorted.length;
  const totalCost = sorted.reduce((sum, sess) => sum + sess.cost.total, 0);
  const totalMessages = sorted.reduce((sum, sess) => sum + sess.messageCount, 0);
  const takeaways: InsightFlag[] = [];
  const recommendations: InsightRecommendation[] = [];
  const stopDoing: InsightRecommendation[] = [];

  const weekOverWeek = temporal.weekOverWeek;
  if (weekOverWeek) {
    takeaways.push({
      severity: "info",
      title: "Activity change",
      detail: describeDelta("session", weekOverWeek.sessionsDelta, "in the current 7-day window compared with the previous 7 days."),
    });
  }

  const topProject = projectStats[0];
  if (topProject) {
    takeaways.push({
      severity: "info",
      title: "Primary project",
      detail: `${topProject.name} accounts for ${topProject.sessions} of ${totalSessions} sessions and ${formatPercent(topProject.cost, totalCost)} of observed spend.`,
    });
  }

  const primaryModel = modelStats[0];
  if (primaryModel) {
    takeaways.push({
      severity: "info",
      title: "Primary model",
      detail: `${primaryModel.name} produced ${formatPercent(primaryModel.tokens, sorted.reduce((sum, sess) => sum + sess.tokenUsage.total, 0))} of observed tokens.`,
    });
  }

  if (temporal.trajectory?.errors) {
    takeaways.push({
      severity: temporal.trajectory.errors === "worsening" ? "warning" : "info",
      title: "Tool-error trend",
      detail: `Tool-error trend is ${temporal.trajectory.errors}.`,
    });
  }

  if (weekOverWeek && temporal.trajectory?.cost === "worsening" && weekOverWeek.costDelta > 0) {
    recommendations.push({
      title: "Audit recent cost drivers",
      detail: `Recent spend increased by ${formatCurrency(weekOverWeek.costDelta)}. Review the most expensive recent sessions before changing default models or prompts.`,
      category: "workflow",
    });
  }

  for (const recommendation of modelEfficiency.recommendations) {
    recommendations.push({ title: "Tune model usage", detail: recommendation, category: "model" });
  }

  for (const signal of temporal.deterministicFriction?.ongoing ?? []) {
    if (signal.title === "Tool errors") {
      recommendations.push({
        title: "Fix tool-error hotspots",
        detail: `${signal.detail} Check failing command/tool patterns before repeating the same workflow.`,
        category: "workflow",
      });
      stopDoing.push({
        title: "Stop retrying failed tool calls blindly",
        detail: "Inspect the first failure and adjust inputs before rerunning similar commands.",
        category: "stop",
      });
    } else if (signal.title === "Slow responses") {
      recommendations.push({
        title: "Split slow sessions into checkpoints",
        detail: `${signal.detail} Smaller scopes usually make progress easier to verify and resume.`,
        category: "workflow",
      });
    } else if (signal.title === "Interruptions") {
      recommendations.push({
        title: "Clarify success criteria before long runs",
        detail: `${signal.detail} Add explicit verification targets before starting broad tasks.`,
        category: "workflow",
      });
    }
  }

  if (totalSessions >= 3 && modelSwitchCount / totalSessions >= 0.25) {
    recommendations.push({
      title: "Make model switching deliberate",
      detail: `${modelSwitchCount} of ${totalSessions} sessions used multiple models. Split lightweight lookups from high-reasoning implementation work when possible.`,
      category: "model",
    });
    stopDoing.push({
      title: "Stop switching models mid-session without a reason",
      detail: "Use a stronger model for planning/review and a faster model for routine edits, rather than mixing ad hoc within one task.",
      category: "stop",
    });
  }

  if (topProject && totalCost > 0 && topProject.cost / totalCost >= 0.5 && projectStats.length > 1) {
    recommendations.push({
      title: "Review the dominant project",
      detail: `${topProject.name} represents ${formatPercent(topProject.cost, totalCost)} of spend. Check whether repeated work there can be captured in tests, docs, or reusable commands.`,
      category: "workflow",
    });
  }

  if (totalSessions > 0 && totalMessages / totalSessions >= 25) {
    recommendations.push({
      title: "Checkpoint long conversations",
      detail: `Average depth is ${Math.round(totalMessages / totalSessions)} messages per session. Save plans, test commands, and open questions before context gets noisy.`,
      category: "workflow",
    });
  }

  if (rageStats.messagesWithSwears > 0) {
    stopDoing.push({
      title: "Stop pushing through frustration signals",
      detail: `${rageStats.messagesWithSwears} messages contained rage language. Treat these as points to narrow scope, inspect logs, or ask for clarification.`,
      category: "stop",
    });
  }

  if (recommendations.length === 0 && topProject && primaryModel) {
    recommendations.push({
      title: "Keep monitoring the main workflow",
      detail: `No deterministic friction stood out. Continue watching ${topProject.name} and ${primaryModel.name} for changes in spend, errors, and session length.`,
      category: "workflow",
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    takeaways: dedupeFlags(takeaways),
    recommendations: dedupeRecommendationObjects(recommendations),
    stopDoing: dedupeRecommendationObjects(stopDoing),
  };
}

function summarizeSessions(sessions: ParsedSession[]) {
  return sessions.reduce((summary, sess) => {
    summary.sessions++;
    summary.messages += sess.messageCount;
    summary.tokens += sess.tokenUsage.total;
    summary.cost += sess.cost.total;
    summary.toolErrors += sess.toolCallErrors;
    summary.interruptions += sess.metadata?.userInterruptions ?? 0;
    summary.slowResponses += (sess.metadata?.responseTimesMs ?? []).filter(ms => ms > 60_000).length;
    return summary;
  }, { sessions: 0, messages: 0, tokens: 0, cost: 0, toolErrors: 0, interruptions: 0, slowResponses: 0 });
}

function computeDecayWeightedActivity(sorted: ParsedSession[], end: Date) {
  return sorted.reduce((weighted, sess) => {
    const ageDays = Math.max(0, (end.getTime() - sess.startTime.getTime()) / MS_PER_DAY);
    const weight = Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS);
    weighted.sessions += weight;
    weighted.messages += sess.messageCount * weight;
    weighted.tokens += sess.tokenUsage.total * weight;
    weighted.cost += sess.cost.total * weight;
    return weighted;
  }, { sessions: 0, messages: 0, tokens: 0, cost: 0 });
}

function compareTrend(current: number, previous: number, lowerIsBetter = false): "improving" | "worsening" | "stable" {
  if (previous === 0 && current === 0) return "stable";
  if (previous === 0) return lowerIsBetter ? "worsening" : "improving";
  const ratio = current / previous;
  if (ratio > 1.1) return lowerIsBetter ? "worsening" : "improving";
  if (ratio < 0.9) return lowerIsBetter ? "improving" : "worsening";
  return "stable";
}

function detectAnomalies(sorted: ParsedSession[]): InsightFlag[] {
  return [
    ...metricAnomalies(sorted, sess => sess.cost.total, "Cost spike", "Session cost is unusually high compared with nearby history."),
    ...metricAnomalies(sorted, sess => sess.toolCallErrors, "Tool error spike", "Session tool errors are unusually high compared with nearby history."),
  ];
}

function metricAnomalies(
  sessions: ParsedSession[],
  selector: (session: ParsedSession) => number,
  title: string,
  detail: string
): InsightFlag[] {
  if (sessions.length < 3) return [];
  const values = sessions.map(selector);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length;
  const threshold = mean + Math.sqrt(variance) * 2;

  return sessions
    .filter(sess => selector(sess) > 0 && selector(sess) > threshold)
    .map(sess => ({ severity: "warning" as const, title, detail, sessionIds: [sess.id] }));
}

function computeDeterministicFriction(
  current: ReturnType<typeof summarizeSessions>,
  previous: ReturnType<typeof summarizeSessions>
): TemporalInsights["deterministicFriction"] {
  const ongoing: InsightFlag[] = [];
  const resolved: InsightFlag[] = [];
  collectFriction("Tool errors", current.toolErrors, previous.toolErrors, ongoing, resolved);
  collectFriction("Slow responses", current.slowResponses, previous.slowResponses, ongoing, resolved);
  collectFriction("Interruptions", current.interruptions, previous.interruptions, ongoing, resolved);
  return { ongoing, resolved };
}

function collectFriction(
  label: string,
  current: number,
  previous: number,
  ongoing: InsightFlag[],
  resolved: InsightFlag[]
): void {
  if (current > 0) {
    ongoing.push({ severity: "warning", title: label, detail: `${current} recent ${label.toLowerCase()} signal${current === 1 ? "" : "s"} detected.` });
  } else if (previous > 0) {
    resolved.push({ severity: "info", title: label, detail: `No recent ${label.toLowerCase()} signals after ${previous} in the previous period.` });
  }
}

function modelEfficiencyRecommendations(models: ModelEfficiencySummary["models"]): string[] {
  if (models.length === 0) return [];
  const recommendations: string[] = [];
  const byCostPerToken = [...models].sort((a, b) => b.costPerToken - a.costPerToken);
  const mostExpensive = byCostPerToken[0];
  const median = byCostPerToken[Math.floor(byCostPerToken.length / 2)]?.costPerToken ?? mostExpensive.costPerToken;

  if (median > 0 && mostExpensive.costPerToken > median * 2) {
    recommendations.push(`${mostExpensive.model} has the highest observed cost per token; reserve it for tasks that need that capability.`);
  }

  const errorProne = models.find(model => (model.toolErrorRate ?? 0) > 0.2);
  if (errorProne) {
    recommendations.push(`${errorProne.model} appears in sessions with frequent tool errors; inspect prompts or tool usage before increasing usage.`);
  }

  return recommendations;
}

function describeDelta(noun: string, delta: number, suffix: string): string {
  if (delta === 0) return `No ${noun} change ${suffix}`;
  const abs = Math.abs(delta);
  const plural = abs === 1 ? noun : `${noun}s`;
  return `${abs} ${delta > 0 ? "more" : "fewer"} ${plural} ${suffix}`;
}

function formatPercent(part: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}

function formatCurrency(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 0.1 ? 2 : 4;
  return `${value < 0 ? "-" : ""}$${abs.toFixed(digits)}`;
}

function dedupeFlags(flags: InsightFlag[]): InsightFlag[] {
  const seen = new Set<string>();
  return flags.filter(flag => {
    const key = `${flag.title}\n${flag.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeRecommendationObjects(recommendations: InsightRecommendation[]): InsightRecommendation[] {
  const seen = new Set<string>();
  return recommendations.filter(recommendation => {
    const key = `${recommendation.title}\n${recommendation.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function emptyAnalytics(): Analytics {
  const emptyRage: RageStats = {
    total: 0,
    messagesWithSwears: 0,
    byModel: [],
    byHour: Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 })),
    byProject: [],
    topWords: [],
  };
  return {
    totalSessions: 0,
    totalMessages: 0,
    totalTokens: 0,
    totalCost: 0,
    totalDuration: 0,
    avgSessionDuration: 0,
    avgMessagesPerSession: 0,
    dateRange: { start: "", end: "" },
    dailyStats: [],
    projectStats: [],
    modelStats: [],
    topTools: [],
    thinkingLevelDistribution: [],
    stopReasonDistribution: [],
    hourlyDistribution: Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 })),
    modelSwitchCount: 0,
    rageStats: emptyRage,
    sessions: [],
  };
}
