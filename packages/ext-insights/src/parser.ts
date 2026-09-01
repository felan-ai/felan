import path from "node:path";
import type { ParsedSession, SessionActivity, SessionEvent, SessionMessage } from "./types.js";
import { detectRage } from "./rage.js";

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".json": "JSON",
  ".md": "Markdown",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".css": "CSS",
  ".html": "HTML",
  ".sql": "SQL",
};

export function parseSessionTranscript(content: string, sourceId: string): ParsedSession | null {
  try {
    let sessionId = "";
    let cwd = "";
    let startTime: Date | null = null;
    let endTime: Date | null = null;
    let userMessages = 0;
    let assistantMessages = 0;
    let toolCallCount = 0;
    let toolCallErrors = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalTokens = 0;
    let totalCost = 0;
    let costInput = 0;
    let costOutput = 0;
    let costCacheRead = 0;
    let costCacheWrite = 0;
    const models: Record<string, { count: number; tokens: number; cost: number }> = {};
    const providers: Record<string, number> = {};
    const thinkingLevels: Record<string, number> = {};
    const toolUsage: Record<string, number> = {};
    const stopReasons: Record<string, number> = {};
    let currentModel = "unknown";
    const rageHits: ParsedSession["rageHits"] = [];
    const responseTimesMs: number[] = [];
    const activityByHour: Record<string, number> = {};
    const filesMentioned = new Set<string>();
    const languageCounts: Record<string, number> = {};
    const toolErrorsByName: Record<string, number> = {};
    const gitActivity = { commits: 0, pushes: 0, statusChecks: 0, diffs: 0 };
    let lastUserMessageAt: Date | null = null;
    let userInterruptions = 0;
    const activity: SessionActivity[] = [];

    for (const line of content.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as SessionEvent;

        if (!startTime && event.timestamp) startTime = new Date(event.timestamp);
        if (event.timestamp) endTime = new Date(event.timestamp);

        const eventTime = event.timestamp ? new Date(event.timestamp) : null;
        if (eventTime && event.type === "message") {
          const hour = String(eventTime.getHours());
          activityByHour[hour] = (activityByHour[hour] ?? 0) + 1;
        }

        if (event.type === "interrupt" || event.type === "user_interrupt" || event.type === "abort") {
          userInterruptions++;
        }

        if (event.type === "session" || event.type === "session_info") {
          const data = event as unknown as { id?: string; cwd?: string };
          if (data.id) sessionId = data.id;
          if (data.cwd) cwd = data.cwd;
        }

        if (event.type === "model_change") {
          const data = event as unknown as { modelId?: string; provider?: string };
          if (data.modelId) {
            models[data.modelId] = models[data.modelId] ?? { count: 0, tokens: 0, cost: 0 };
            models[data.modelId].count++;
            currentModel = data.modelId;
          }
          if (data.provider) {
            providers[data.provider] = (providers[data.provider] ?? 0) + 1;
          }
        }

        if (event.type === "thinking_level_change") {
          const data = event as unknown as { thinkingLevel?: string };
          if (data.thinkingLevel) {
            thinkingLevels[data.thinkingLevel] = (thinkingLevels[data.thinkingLevel] ?? 0) + 1;
          }
        }

        if (event.type === "message") {
          const msg = (event as unknown as { message: SessionMessage }).message;
          const messageActivity: SessionActivity = eventTime ? { timestamp: eventTime } : { timestamp: new Date(0) };

          if (msg.role === "user") {
            userMessages++;
            messageActivity.userMessageCount = 1;
            lastUserMessageAt = eventTime;
            // Collect rage hits with the message index for accurate per-message dedup
            const textParts: string[] = [];
            if (msg.content) {
              for (const item of msg.content) {
                if (item.type === "text" && item.text) textParts.push(item.text);
              }
            }
            const text = textParts.join(" ");
            if (text) {
              const hour = event.timestamp ? new Date(event.timestamp).getHours() : -1;
              for (const hit of detectRage(text)) {
                rageHits.push({ ...hit, hour, model: currentModel, msgIndex: userMessages });
              }
            }
          } else if (msg.role === "assistant") {
            assistantMessages++;
            messageActivity.assistantMessageCount = 1;

            if (eventTime && lastUserMessageAt) {
              responseTimesMs.push(Math.max(0, eventTime.getTime() - lastUserMessageAt.getTime()));
              lastUserMessageAt = null;
            }

            if (msg.usage) {
              const input = msg.usage.input ?? 0;
              const output = msg.usage.output ?? 0;
              const cacheRead = msg.usage.cacheRead ?? 0;
              const cacheWrite = msg.usage.cacheWrite ?? 0;
              const tokens = msg.usage.totalTokens ?? (input + output + cacheRead);
              const cost = msg.usage.cost?.total ?? 0;

              totalInput += input;
              totalOutput += output;
              totalCacheRead += cacheRead;
              totalCacheWrite += cacheWrite;
              totalTokens += tokens;
              totalCost += cost;
              costInput += msg.usage.cost?.input ?? 0;
              costOutput += msg.usage.cost?.output ?? 0;
              costCacheRead += msg.usage.cost?.cacheRead ?? 0;
              costCacheWrite += msg.usage.cost?.cacheWrite ?? 0;

              messageActivity.tokenUsage = { input, output, cacheRead, cacheWrite, total: tokens };
              messageActivity.cost = {
                input: msg.usage.cost?.input ?? 0,
                output: msg.usage.cost?.output ?? 0,
                cacheRead: msg.usage.cost?.cacheRead ?? 0,
                cacheWrite: msg.usage.cost?.cacheWrite ?? 0,
                total: cost,
              };

              if (msg.model) {
                models[msg.model] = models[msg.model] ?? { count: 0, tokens: 0, cost: 0 };
                models[msg.model].tokens += tokens;
                models[msg.model].cost += cost;
                messageActivity.models = { [msg.model]: { count: 1, tokens, cost } };
              }
              if (msg.provider) messageActivity.providers = { [msg.provider]: 1 };
            }

            if (msg.stopReason) {
              stopReasons[msg.stopReason] = (stopReasons[msg.stopReason] ?? 0) + 1;
              messageActivity.stopReasons = { [msg.stopReason]: 1 };
              if (msg.stopReason.toLowerCase().includes("interrupt")) userInterruptions++;
            }
          }

          if (msg.content) {
            let messageToolCallCount = 0;
            let messageToolCallErrors = 0;
            const messageToolUsage: Record<string, number> = {};
            for (const item of msg.content) {
              if (item.type === "toolCall" && item.name) {
                messageToolCallCount++;
                messageToolUsage[item.name] = (messageToolUsage[item.name] ?? 0) + 1;
                toolCallCount++;
                toolUsage[item.name] = (toolUsage[item.name] ?? 0) + 1;
                collectToolSignals(item.name, [item.input, item.args, item.arguments], filesMentioned, languageCounts, gitActivity);
              }
              if (item.type === "toolResult" && item.isError) {
                messageToolCallErrors++;
                toolCallErrors++;
                recordToolError(toolErrorsByName, item.name);
              }
            }
            if (messageToolCallCount) {
              messageActivity.toolCallCount = messageToolCallCount;
              messageActivity.toolUsage = messageToolUsage;
            }
            if (messageToolCallErrors) messageActivity.toolCallErrors = messageToolCallErrors;
          }

          if (msg.toolCalls) {
            toolCallCount += msg.toolCalls.length;
            messageActivity.toolCallCount = (messageActivity.toolCallCount ?? 0) + msg.toolCalls.length;
            for (const call of msg.toolCalls) {
              if (!call.name) continue;
              messageActivity.toolUsage ??= {};
              messageActivity.toolUsage[call.name] = (messageActivity.toolUsage[call.name] ?? 0) + 1;
            }
            for (const tc of msg.toolCalls) {
              if (tc.name) {
                toolUsage[tc.name] = (toolUsage[tc.name] ?? 0) + 1;
                collectToolSignals(tc.name, [tc.input, tc.args, tc.arguments], filesMentioned, languageCounts, gitActivity);
              }
            }
          }

          if (msg.toolResults) {
            for (const tr of msg.toolResults) {
              if (tr.isError) {
                toolCallErrors++;
                messageActivity.toolCallErrors = (messageActivity.toolCallErrors ?? 0) + 1;
                recordToolError(toolErrorsByName, tr.name);
              }
            }
          }
          activity.push(messageActivity);
        }
      } catch {
        // Skip malformed lines
      }
    }

    if (!startTime) return null;
    if (!endTime) endTime = startTime;

    const duration = Math.max(1, Math.round((endTime.getTime() - startTime.getTime()) / 60000));
    const projectName = cwd ? portableBasename(cwd) : "unknown";
    const primaryModel = getPrimaryModel(models, currentModel);
    const avgResponseTimeMs = responseTimesMs.length > 0
      ? Math.round(responseTimesMs.reduce((sum, value) => sum + value, 0) / responseTimesMs.length)
      : 0;

    return {
      id: sessionId || portableBasename(sourceId).replace(/\.jsonl$/iu, ""),
      cwd,
      projectName,
      startTime,
      endTime,
      duration,
      messageCount: userMessages + assistantMessages,
      userMessageCount: userMessages,
      assistantMessageCount: assistantMessages,
      toolCallCount,
      tokenUsage: { input: totalInput, output: totalOutput, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite, total: totalTokens },
      cost: { input: costInput, output: costOutput, cacheRead: costCacheRead, cacheWrite: costCacheWrite, total: totalCost },
      models,
      providers,
      thinkingLevels,
      toolUsage,
      stopReasons,
      toolCallErrors,
      hasError: toolCallErrors > 0,
      rageHits,
      metadata: {
        primaryModel,
        responseTimesMs,
        avgResponseTimeMs,
        ...(responseTimesMs[0] === undefined ? {} : { firstResponseTimeMs: responseTimesMs[0] }),
        activityByHour,
        filesMentioned: Array.from(filesMentioned).sort(),
        languageCounts,
        gitActivity,
        toolErrorsByName,
        userInterruptions,
      },
      activity,
    };
  } catch {
    return null;
  }
}

export function sliceParsedSession(session: ParsedSession, start?: Date, end?: Date): ParsedSession | null {
  if (!start && !end) return session;
  const activity = (session.activity ?? []).filter((item) =>
    (!start || item.timestamp >= start) && (!end || item.timestamp < end));
  if (!activity.length) return null;

  const first = activity[0]!;
  const last = activity[activity.length - 1]!;
  const sliced: ParsedSession = {
    ...session,
    startTime: first.timestamp,
    endTime: last.timestamp,
    duration: Math.max(1, Math.round((last.timestamp.getTime() - first.timestamp.getTime()) / 60000)),
    messageCount: 0,
    userMessageCount: 0,
    assistantMessageCount: 0,
    toolCallCount: 0,
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
    addModelRecords(sliced.models, item.models);
    addNumbers(sliced.providers, item.providers);
    addNumbers(sliced.thinkingLevels, item.thinkingLevels);
    addNumbers(sliced.toolUsage, item.toolUsage);
    addNumbers(sliced.stopReasons, item.stopReasons);
    sliced.rageHits.push(...(item.rageHits ?? []));
  }
  return sliced;
}

export function mergeParsedSessions(sessions: readonly ParsedSession[], rootSessionId = sessions[0]?.id): ParsedSession | null {
  if (!sessions.length) return null;
  const first = sessions[0]!;
  const merged = sliceParsedSession(first) ?? first;
  merged.id = rootSessionId ?? merged.id;
  merged.agentSessionCount = sessions.reduce((count, session) => count + (session.agentSessionCount ?? 1), 0);
  for (const session of sessions.slice(1)) {
    merged.startTime = new Date(Math.min(merged.startTime.getTime(), session.startTime.getTime()));
    merged.endTime = new Date(Math.max(merged.endTime.getTime(), session.endTime.getTime()));
    merged.duration = Math.max(1, Math.round((merged.endTime.getTime() - merged.startTime.getTime()) / 60000));
    merged.messageCount += session.messageCount;
    merged.userMessageCount += session.userMessageCount;
    merged.assistantMessageCount += session.assistantMessageCount;
    merged.toolCallCount += session.toolCallCount;
    merged.toolCallErrors += session.toolCallErrors;
    merged.hasError ||= session.hasError;
    addNumbers(merged.tokenUsage, session.tokenUsage);
    addNumbers(merged.cost, session.cost);
    addModelRecords(merged.models, session.models);
    addNumbers(merged.providers, session.providers);
    addNumbers(merged.thinkingLevels, session.thinkingLevels);
    addNumbers(merged.toolUsage, session.toolUsage);
    addNumbers(merged.stopReasons, session.stopReasons);
    merged.rageHits.push(...session.rageHits);
    merged.activity = [...(merged.activity ?? []), ...(session.activity ?? [])].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }
  return merged;
}

function addNumbers(target: Record<string, number>, source: Record<string, number> | undefined): void {
  for (const [key, value] of Object.entries(source ?? {})) target[key] = (target[key] ?? 0) + value;
}

function addModelRecords(target: Record<string, { count: number; tokens: number; cost: number }>, source: Record<string, { count: number; tokens: number; cost: number }> | undefined): void {
  for (const [key, value] of Object.entries(source ?? {})) {
    const existing = target[key] as { count: number; tokens: number; cost: number } | undefined;
    if (existing) {
      existing.count += value.count;
      existing.tokens += value.tokens;
      existing.cost += value.cost;
    } else target[key] = { ...value };
  }
}

function portableBasename(value: string): string {
  return value.replace(/[\\/]+$/u, "").split(/[\\/]/u).pop() || value;
}

function collectToolSignals(
  toolName: string,
  inputs: unknown[],
  filesMentioned: Set<string>,
  languageCounts: Record<string, number>,
  gitActivity: NonNullable<ParsedSession["metadata"]>["gitActivity"]
): void {
  for (const input of inputs) {
    for (const filePath of extractFilePaths(input)) {
      filesMentioned.add(filePath);
      const language = languageForPath(filePath);
      if (language) languageCounts[language] = (languageCounts[language] ?? 0) + 1;
    }

    if (toolName.toLowerCase() === "bash") {
      const command = extractCommand(input);
      if (command) recordGitActivity(command, gitActivity);
    }
  }
}

function extractFilePaths(value: unknown, key = ""): string[] {
  if (typeof value === "string") {
    return isPathKey(key) ? normalizeFilePath(value) : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(item => extractFilePaths(item, key));
  }

  if (!value || typeof value !== "object") return [];

  return Object.entries(value as Record<string, unknown>).flatMap(([childKey, childValue]) => {
    if (childKey === "command") return [];
    return extractFilePaths(childValue, childKey);
  });
}

function extractCommand(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const command = (value as { command?: unknown }).command;
  return typeof command === "string" ? command : undefined;
}

function normalizeFilePath(value: string): string[] {
  if (value.includes("\n") || value.length > 500) return [];
  const trimmed = value.trim();
  if (!trimmed || !path.extname(trimmed)) return [];
  return [trimmed];
}

function isPathKey(key: string): boolean {
  return /^(path|file|files|filePath|file_path|notebook_path|outputPath|output_path)$/i.test(key);
}

function languageForPath(filePath: string): string | undefined {
  return LANGUAGE_BY_EXTENSION[path.extname(filePath).toLowerCase()];
}

function recordGitActivity(command: string, gitActivity: NonNullable<ParsedSession["metadata"]>["gitActivity"]): void {
  if (/\bgit\s+commit\b/.test(command)) gitActivity.commits++;
  if (/\bgit\s+push\b/.test(command)) gitActivity.pushes++;
  if (/\bgit\s+status\b/.test(command)) gitActivity.statusChecks++;
  if (/\bgit\s+diff\b/.test(command)) gitActivity.diffs++;
}

function recordToolError(toolErrorsByName: Record<string, number>, toolName?: string): void {
  const key = toolName || "unknown";
  toolErrorsByName[key] = (toolErrorsByName[key] ?? 0) + 1;
}

function getPrimaryModel(models: ParsedSession["models"], fallback: string): string {
  const [primary] = Object.entries(models).sort(([, a], [, b]) => {
    if (b.tokens !== a.tokens) return b.tokens - a.tokens;
    return b.count - a.count;
  });
  return primary?.[0] ?? fallback;
}
