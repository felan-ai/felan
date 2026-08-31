import { describe, it, expect } from "vitest";
import { computeAnalytics } from "../src/analytics.js";
import type { ParsedSession } from "../src/types.js";

function makeSession(overrides: Partial<ParsedSession> = {}): ParsedSession {
  const startTime = new Date("2025-03-15T10:00:00Z");
  const endTime = new Date("2025-03-15T10:30:00Z");
  return {
    id: "sess-1",
    cwd: "/home/user/my-project",
    projectName: "my-project",
    startTime,
    endTime,
    duration: 30,
    messageCount: 10,
    userMessageCount: 5,
    assistantMessageCount: 5,
    toolCallCount: 3,
    tokenUsage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 0, total: 1700 },
    cost: { input: 0.01, output: 0.005, cacheRead: 0.001, cacheWrite: 0, total: 0.016 },
    models: { "gpt-4": { count: 1, tokens: 1700, cost: 0.016 } },
    providers: { "openai": 1 },
    thinkingLevels: { "medium": 2 },
    toolUsage: { "Read": 2, "Write": 1 },
    stopReasons: { "stop": 5 },
    toolCallErrors: 0,
    hasError: false,
    rageHits: [],
    ...overrides,
  };
}

describe("computeAnalytics", () => {
  describe("empty input", () => {
    it("returns zeros and empty arrays for no sessions", () => {
      const result = computeAnalytics([]);
      expect(result.totalSessions).toBe(0);
      expect(result.totalMessages).toBe(0);
      expect(result.totalTokens).toBe(0);
      expect(result.totalCost).toBe(0);
      expect(result.avgSessionDuration).toBe(0);
      expect(result.avgMessagesPerSession).toBe(0);
      expect(result.dailyStats).toEqual([]);
      expect(result.projectStats).toEqual([]);
      expect(result.modelStats).toEqual([]);
      expect(result.sessions).toEqual([]);
    });

    it("returns 24 hourly buckets all zero for no sessions", () => {
      const result = computeAnalytics([]);
      expect(result.hourlyDistribution).toHaveLength(24);
      expect(result.hourlyDistribution.every(h => h.count === 0)).toBe(true);
    });

    it("returns empty rageStats for no sessions", () => {
      const result = computeAnalytics([]);
      expect(result.rageStats.total).toBe(0);
      expect(result.rageStats.byHour).toHaveLength(24);
    });
  });

  describe("single session", () => {
    it("computes totals correctly", () => {
      const sess = makeSession();
      const result = computeAnalytics([sess]);
      expect(result.totalSessions).toBe(1);
      expect(result.totalMessages).toBe(10);
      expect(result.totalTokens).toBe(1700);
      expect(result.totalCost).toBeCloseTo(0.016);
    });

    it("maps session to correct date in dailyStats", () => {
      const sess = makeSession();
      const result = computeAnalytics([sess]);
      expect(result.dailyStats).toHaveLength(1);
      expect(result.dailyStats[0].date).toBe("2025-03-15");
      expect(result.dailyStats[0].sessions).toBe(1);
    });

    it("creates projectStats from cwd basename", () => {
      const sess = makeSession();
      const result = computeAnalytics([sess]);
      expect(result.projectStats).toHaveLength(1);
      expect(result.projectStats[0].name).toBe("my-project");
    });

    it("serializes startTime and endTime as ISO strings in sessions output", () => {
      const sess = makeSession();
      const result = computeAnalytics([sess]);
      expect(result.sessions[0].startTime).toBe("2025-03-15T10:00:00.000Z");
      expect(result.sessions[0].endTime).toBe("2025-03-15T10:30:00.000Z");
    });

    it("computes average session duration correctly", () => {
      const sess = makeSession({ duration: 45 });
      const result = computeAnalytics([sess]);
      expect(result.avgSessionDuration).toBe(45);
    });

    it("puts top tools in descending order", () => {
      const sess = makeSession({ toolUsage: { "Read": 10, "Write": 5, "Bash": 1 } });
      const result = computeAnalytics([sess]);
      expect(result.topTools[0].name).toBe("Read");
      expect(result.topTools[1].name).toBe("Write");
    });
  });

  describe("multiple sessions", () => {
    it("sums messages across sessions", () => {
      const sessions = [
        makeSession({ id: "s1", messageCount: 10 }),
        makeSession({ id: "s2", messageCount: 20 }),
      ];
      const result = computeAnalytics(sessions);
      expect(result.totalMessages).toBe(30);
    });

    it("groups same-day sessions in dailyStats", () => {
      const sessions = [
        makeSession({ id: "s1", startTime: new Date("2025-03-15T09:00:00Z"), endTime: new Date("2025-03-15T09:30:00Z") }),
        makeSession({ id: "s2", startTime: new Date("2025-03-15T14:00:00Z"), endTime: new Date("2025-03-15T14:30:00Z") }),
      ];
      const result = computeAnalytics(sessions);
      expect(result.dailyStats).toHaveLength(1);
      expect(result.dailyStats[0].sessions).toBe(2);
    });

    it("separates sessions on different days in dailyStats", () => {
      const sessions = [
        makeSession({ id: "s1", startTime: new Date("2025-03-15T09:00:00Z"), endTime: new Date("2025-03-15T09:30:00Z") }),
        makeSession({ id: "s2", startTime: new Date("2025-03-16T14:00:00Z"), endTime: new Date("2025-03-16T14:30:00Z") }),
      ];
      const result = computeAnalytics(sessions);
      expect(result.dailyStats).toHaveLength(2);
    });

    it("sorts sessions chronologically before processing", () => {
      const sessions = [
        makeSession({ id: "s2", startTime: new Date("2025-03-16T10:00:00Z"), endTime: new Date("2025-03-16T10:30:00Z") }),
        makeSession({ id: "s1", startTime: new Date("2025-03-15T10:00:00Z"), endTime: new Date("2025-03-15T10:30:00Z") }),
      ];
      const result = computeAnalytics(sessions);
      expect(result.dateRange.start).toBe("2025-03-15");
      expect(result.dateRange.end).toBe("2025-03-16");
    });

    it("counts modelSwitchCount for sessions with >1 model", () => {
      const singleModel = makeSession({ id: "s1", models: { "gpt-4": { count: 1, tokens: 100, cost: 0.01 } } });
      const multiModel = makeSession({
        id: "s2",
        models: {
          "gpt-4":   { count: 1, tokens: 100, cost: 0.01 },
          "claude-3": { count: 1, tokens: 100, cost: 0.01 },
        },
      });
      const result = computeAnalytics([singleModel, multiModel]);
      expect(result.modelSwitchCount).toBe(1);
    });

    it("aggregates model stats across sessions", () => {
      const sessions = [
        makeSession({ id: "s1", models: { "gpt-4": { count: 1, tokens: 500, cost: 0.01 } } }),
        makeSession({ id: "s2", models: { "gpt-4": { count: 2, tokens: 300, cost: 0.005 } } }),
      ];
      const result = computeAnalytics(sessions);
      const gpt4 = result.modelStats.find(m => m.name === "gpt-4");
      expect(gpt4).toBeDefined();
      expect(gpt4!.tokens).toBe(800);
      expect(gpt4!.count).toBe(3);
    });

    it("filters out models with zero tokens from modelStats", () => {
      const sess = makeSession({
        models: {
          "active-model": { count: 5, tokens: 1000, cost: 0.01 },
          "switch-only-model": { count: 1, tokens: 0, cost: 0 },
        },
      });
      const result = computeAnalytics([sess]);
      expect(result.modelStats.find(m => m.name === "active-model")).toBeDefined();
      expect(result.modelStats.find(m => m.name === "switch-only-model")).toBeUndefined();
    });

    it("limits topTools to 10 entries", () => {
      const toolUsage: Record<string, number> = {};
      for (let i = 0; i < 15; i++) toolUsage[`Tool${i}`] = 15 - i;
      const sess = makeSession({ toolUsage });
      const result = computeAnalytics([sess]);
      expect(result.topTools).toHaveLength(10);
    });

    it("accumulates hourlyDistribution across sessions", () => {
      // Use local-time Date constructor so getHours() returns the expected hour
      // regardless of the timezone the test runs in.
      const sessions = [
        makeSession({ id: "s1", startTime: new Date(2025, 2, 15, 9, 0, 0),  endTime: new Date(2025, 2, 15, 9, 30, 0) }),
        makeSession({ id: "s2", startTime: new Date(2025, 2, 15, 9, 30, 0), endTime: new Date(2025, 2, 15, 10, 0, 0) }),
        makeSession({ id: "s3", startTime: new Date(2025, 2, 15, 14, 0, 0), endTime: new Date(2025, 2, 15, 14, 30, 0) }),
      ];
      const result = computeAnalytics(sessions);
      const hour9 = result.hourlyDistribution.find(h => h.hour === 9);
      const hour14 = result.hourlyDistribution.find(h => h.hour === 14);
      expect(hour9?.count).toBe(2);
      expect(hour14?.count).toBe(1);
    });
  });

  describe("rage stats", () => {
    it("returns zero rage stats when no hits", () => {
      const result = computeAnalytics([makeSession()]);
      expect(result.rageStats.total).toBe(0);
      expect(result.rageStats.messagesWithSwears).toBe(0);
      expect(result.rageStats.byModel).toEqual([]);
      expect(result.rageStats.topWords).toEqual([]);
    });

    it("counts total rage hits across sessions", () => {
      const sess = makeSession({
        rageHits: [
          { word: "fuck", group: "fuck", hour: 10, model: "gpt-4", msgIndex: 1 },
          { word: "shit", group: "shit", hour: 10, model: "gpt-4", msgIndex: 1 },
          { word: "damn", group: "damn", hour: 11, model: "gpt-4", msgIndex: 2 },
        ],
      });
      const result = computeAnalytics([sess]);
      expect(result.rageStats.total).toBe(3);
    });

    it("counts unique messages with swears (not unique words)", () => {
      const sess = makeSession({
        rageHits: [
          { word: "fuck", group: "fuck", hour: 10, model: "gpt-4", msgIndex: 1 },
          { word: "shit", group: "shit", hour: 10, model: "gpt-4", msgIndex: 1 }, // same msg
          { word: "damn", group: "damn", hour: 11, model: "gpt-4", msgIndex: 2 },
        ],
      });
      const result = computeAnalytics([sess]);
      expect(result.rageStats.messagesWithSwears).toBe(2); // msg 1 and msg 2
    });

    it("groups hits by model", () => {
      const sess = makeSession({
        rageHits: [
          { word: "fuck", group: "fuck", hour: 10, model: "gpt-4",    msgIndex: 1 },
          { word: "shit", group: "shit", hour: 11, model: "claude-3", msgIndex: 2 },
          { word: "damn", group: "damn", hour: 12, model: "gpt-4",    msgIndex: 3 },
        ],
      });
      const result = computeAnalytics([sess]);
      const gpt4 = result.rageStats.byModel.find(m => m.name === "gpt-4");
      const claude = result.rageStats.byModel.find(m => m.name === "claude-3");
      expect(gpt4?.count).toBe(2);
      expect(claude?.count).toBe(1);
    });

    it("groups hits by hour", () => {
      const sess = makeSession({
        rageHits: [
          { word: "fuck", group: "fuck", hour: 10, model: "m", msgIndex: 1 },
          { word: "shit", group: "shit", hour: 10, model: "m", msgIndex: 2 },
          { word: "damn", group: "damn", hour: 14, model: "m", msgIndex: 3 },
        ],
      });
      const result = computeAnalytics([sess]);
      const hour10 = result.rageStats.byHour.find(h => h.hour === 10);
      const hour14 = result.rageStats.byHour.find(h => h.hour === 14);
      expect(hour10?.count).toBe(2);
      expect(hour14?.count).toBe(1);
    });

    it("returns byHour with all 24 buckets", () => {
      const result = computeAnalytics([makeSession()]);
      expect(result.rageStats.byHour).toHaveLength(24);
      expect(result.rageStats.byHour[0].hour).toBe(0);
      expect(result.rageStats.byHour[23].hour).toBe(23);
    });

    it("ranks topWords by frequency", () => {
      const sess = makeSession({
        rageHits: [
          { word: "fuck", group: "fuck", hour: 10, model: "m", msgIndex: 1 },
          { word: "fuck", group: "fuck", hour: 11, model: "m", msgIndex: 2 },
          { word: "shit", group: "shit", hour: 12, model: "m", msgIndex: 3 },
        ],
      });
      const result = computeAnalytics([sess]);
      expect(result.rageStats.topWords[0].word).toBe("fuck");
      expect(result.rageStats.topWords[0].count).toBe(2);
    });

    it("skips hits with hour -1 from byHour (unknown timestamp)", () => {
      const sess = makeSession({
        rageHits: [
          { word: "fuck", group: "fuck", hour: -1, model: "m", msgIndex: 1 },
        ],
      });
      const result = computeAnalytics([sess]);
      expect(result.rageStats.byHour.every(h => h.count === 0)).toBe(true);
    });
  });

  describe("dateRange", () => {
    it("sets start to earliest session and end to latest", () => {
      const sessions = [
        makeSession({ id: "s1", startTime: new Date("2025-01-01T00:00:00Z"), endTime: new Date("2025-01-01T01:00:00Z") }),
        makeSession({ id: "s2", startTime: new Date("2025-06-15T00:00:00Z"), endTime: new Date("2025-06-15T01:00:00Z") }),
      ];
      const result = computeAnalytics(sessions);
      expect(result.dateRange.start).toBe("2025-01-01");
      expect(result.dateRange.end).toBe("2025-06-15");
    });
  });

  describe("temporal insights", () => {
    it("computes week-over-week trajectory and deterministic friction", () => {
      const sessions = [
        makeSession({
          id: "previous",
          startTime: new Date("2025-03-05T10:00:00Z"),
          endTime: new Date("2025-03-05T10:30:00Z"),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
          toolCallErrors: 2,
          metadata: {
            primaryModel: "gpt-4",
            responseTimesMs: [90_000],
            avgResponseTimeMs: 90_000,
            firstResponseTimeMs: 90_000,
            activityByHour: { "10": 2 },
            filesMentioned: [],
            languageCounts: {},
            gitActivity: { commits: 0, pushes: 0, statusChecks: 0, diffs: 0 },
            toolErrorsByName: { Bash: 2 },
            userInterruptions: 1,
          },
        }),
        makeSession({
          id: "current",
          startTime: new Date("2025-03-15T10:00:00Z"),
          endTime: new Date("2025-03-15T10:30:00Z"),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
          toolCallErrors: 0,
        }),
      ];

      const result = computeAnalytics(sessions);

      expect(result.temporal?.weekOverWeek?.sessionsDelta).toBe(0);
      expect(result.temporal?.weekOverWeek?.toolErrorDelta).toBe(-2);
      expect(result.temporal?.trajectory?.cost).toBe("improving");
      expect(result.temporal?.trajectory?.errors).toBe("improving");
      expect(result.temporal?.deterministicFriction?.resolved.map(item => item.title)).toEqual(["Tool errors", "Slow responses", "Interruptions"]);
      expect(result.temporal?.decayWeightedActivity?.sessions).toBeGreaterThan(1);
    });

    it("detects cost anomalies", () => {
      const sessions = Array.from({ length: 10 }, (_, index) => makeSession({
        id: `normal-${index}`,
        startTime: new Date(`2025-03-${String(index + 1).padStart(2, "0")}T10:00:00Z`),
        endTime: new Date(`2025-03-${String(index + 1).padStart(2, "0")}T10:30:00Z`),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
      })).concat(makeSession({
        id: "spike",
        startTime: new Date("2025-03-15T10:00:00Z"),
        endTime: new Date("2025-03-15T10:30:00Z"),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
      }));

      const result = computeAnalytics(sessions);

      expect(result.temporal?.anomalies?.some(item => item.title === "Cost spike" && item.sessionIds?.includes("spike"))).toBe(true);
    });
  });

  describe("modelEfficiency", () => {
    it("computes model efficiency summaries", () => {
      const sessions = [
        makeSession({
          id: "s1",
          duration: 20,
          toolCallErrors: 1,
          models: { opus: { count: 2, tokens: 100, cost: 1 } },
        }),
        makeSession({
          id: "s2",
          duration: 40,
          models: { sonnet: { count: 4, tokens: 1000, cost: 0.1 } },
        }),
      ];

      const result = computeAnalytics(sessions);
      const opus = result.modelEfficiency?.models.find(model => model.model === "opus");

      expect(opus?.costPerToken).toBeCloseTo(0.01);
      expect(opus?.costPerMessage).toBeCloseTo(0.5);
      expect(opus?.avgSessionDuration).toBe(20);
      expect(opus?.toolErrorRate).toBe(1);
      expect(result.modelEfficiency?.recommendations.join(" ")).toContain("opus");
    });
  });

  describe("deterministic analysis", () => {
    it("generates actionable recommendations without AI facets", () => {
      const sessions = [
        makeSession({
          id: "previous",
          projectName: "secondary",
          startTime: new Date("2025-03-05T10:00:00Z"),
          endTime: new Date("2025-03-05T10:30:00Z"),
          models: { sonnet: { count: 2, tokens: 500, cost: 0.05 } },
        }),
        makeSession({
          id: "current",
          projectName: "main-project",
          startTime: new Date("2025-03-15T10:00:00Z"),
          endTime: new Date("2025-03-15T10:30:00Z"),
          toolCallErrors: 2,
          models: {
            opus: { count: 2, tokens: 100, cost: 1 },
            sonnet: { count: 2, tokens: 1000, cost: 0.1 },
          },
          rageHits: [{ word: "damn", group: "damn", hour: 10, model: "opus", msgIndex: 1 }],
        }),
      ];

      const result = computeAnalytics(sessions);

      expect(result.ai).toBeUndefined();
      expect(result.analysis?.takeaways.map(item => item.title)).toContain("Primary project");
      expect(result.analysis?.recommendations.map(item => item.title)).toContain("Fix tool-error hotspots");
      expect(result.analysis?.recommendations.map(item => item.title)).toContain("Tune model usage");
      expect(result.analysis?.stopDoing.map(item => item.title)).toContain("Stop retrying failed tool calls blindly");
      expect(result.analysis?.stopDoing.map(item => item.title)).toContain("Stop pushing through frustration signals");
    });
  });
});
