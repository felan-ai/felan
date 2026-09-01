import type { ParsedSession, SessionActivity } from './types.js';

export function sliceParsedSession(session: ParsedSession, start?: Date, end?: Date): ParsedSession | null {
  if (!start && !end) return session;
  const activity = (session.activity ?? []).filter((item) =>
    (!start || item.timestamp >= start) && (!end || item.timestamp < end));
  if (!activity.length) return null;
  const first = activity[0]!;
  const last = activity[activity.length - 1]!;
  const sliced: ParsedSession = {
    ...session, startTime: first.timestamp, endTime: last.timestamp,
    duration: Math.max(1, Math.round((last.timestamp.getTime() - first.timestamp.getTime()) / 60000)),
    messageCount: 0, userMessageCount: 0, assistantMessageCount: 0, toolCallCount: 0,
    tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    models: {}, providers: {}, thinkingLevels: {}, toolUsage: {}, stopReasons: {},
    toolCallErrors: 0, hasError: false, rageHits: [], activity,
  };
  for (const item of activity) {
    sliced.userMessageCount += item.userMessageCount ?? 0;
    sliced.assistantMessageCount += item.assistantMessageCount ?? 0;
    sliced.messageCount += (item.userMessageCount ?? 0) + (item.assistantMessageCount ?? 0);
    sliced.toolCallCount += item.toolCallCount ?? 0;
    sliced.toolCallErrors += item.toolCallErrors ?? 0;
    sliced.hasError ||= (item.toolCallErrors ?? 0) > 0;
    addNumbers(sliced.tokenUsage, item.tokenUsage);
    addNumbers(sliced.cost, item.cost);
    addModels(sliced.models, item.models);
    addNumbers(sliced.providers, item.providers);
    addNumbers(sliced.thinkingLevels, item.thinkingLevels);
    addNumbers(sliced.toolUsage, item.toolUsage);
    addNumbers(sliced.stopReasons, item.stopReasons);
    sliced.rageHits.push(...(item.rageHits ?? []));
  }
  return sliced;
}

function addNumbers(target: Record<string, number>, source: Record<string, number> | undefined): void {
  for (const [key, value] of Object.entries(source ?? {})) target[key] = (target[key] ?? 0) + value;
}

function addModels(target: Record<string, { count: number; tokens: number; cost: number }>, source: Record<string, { count: number; tokens: number; cost: number }> | undefined): void {
  for (const [key, value] of Object.entries(source ?? {})) {
    const current = target[key];
    if (current) { current.count += value.count; current.tokens += value.tokens; current.cost += value.cost; }
    else target[key] = { ...value };
  }
}

export type { SessionActivity };
