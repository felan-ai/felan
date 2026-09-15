import type {
  ParsedSession,
  Analytics,
  DailyStats,
  ProjectStats,
  ModelStats,
  RageStats,
  ModelEfficiencySummary,
} from "./types.js";

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
    const activity = sess.activity?.length ? sess.activity : [{
      timestamp: sess.startTime,
      userMessageCount: sess.userMessageCount,
      assistantMessageCount: sess.assistantMessageCount,
      tokenUsage: sess.tokenUsage,
      cost: sess.cost,
    }];
    const firstDate = activity[0]!.timestamp.toISOString().split("T")[0];
    for (const item of activity) {
      const date = item.timestamp.toISOString().split("T")[0];
      const existing = dailyMap.get(date) ?? { date, sessions: 0, messages: 0, tokens: 0, cost: 0 };
      if (date === firstDate) existing.sessions++;
      existing.messages += (item.userMessageCount ?? 0) + (item.assistantMessageCount ?? 0);
      existing.tokens += item.tokenUsage?.total ?? 0;
      existing.cost += item.cost?.total ?? 0;
      dailyMap.set(date, existing);
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

  const modelEfficiency = computeModelEfficiency(sorted);

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
    modelEfficiency,
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
      activity: s.activity?.map((item) => ({ ...item, timestamp: item.timestamp.toISOString() })),
      agentSessionCount: s.agentSessionCount,
    })),
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
  };
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
