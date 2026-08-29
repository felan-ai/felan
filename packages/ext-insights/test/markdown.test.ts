import { describe, expect, it } from "vitest";
import { generateMarkdown } from "../src/markdown.js";
import type { Analytics } from "../src/types.js";

function makeAnalytics(overrides: Partial<Analytics> = {}): Analytics {
  return {
    totalSessions: 2,
    totalMessages: 30,
    totalTokens: 3000,
    totalCost: 1.25,
    totalDuration: 90,
    avgSessionDuration: 45,
    avgMessagesPerSession: 15,
    dateRange: { start: "2025-03-01", end: "2025-03-15" },
    dailyStats: [],
    projectStats: [{ name: "project-a", sessions: 2, messages: 30, tokens: 3000, cost: 1.25, duration: 90 }],
    modelStats: [
      { name: "opus", count: 20, tokens: 2000, cost: 1, avgDuration: 60 },
      { name: "sonnet", count: 10, tokens: 1000, cost: 0.25, avgDuration: 30 },
    ],
    topTools: [
      { name: "Read", count: 12 },
      { name: "Bash|Shell", count: 3 },
    ],
    thinkingLevelDistribution: [],
    stopReasonDistribution: [],
    hourlyDistribution: [],
    modelSwitchCount: 1,
    rageStats: { total: 1, messagesWithSwears: 1, byModel: [], byHour: [], byProject: [], topWords: [] },
    sessions: [],
    export: {
      generatedAt: "2025-03-16T00:00:00.000Z",
      outputFormats: ["html", "markdown"],
      htmlPath: "/reports/felan-insights.html",
      markdownPath: "/reports/pi-insights.md",
    },
    temporal: {
      generatedAt: "2025-03-16T00:00:00.000Z",
      decayWeightedActivity: { sessions: 1.75, messages: 20, tokens: 2500, cost: 0.9 },
      weekOverWeek: { currentStart: "2025-03-08", previousStart: "2025-03-01", sessionsDelta: 1, costDelta: -0.5, toolErrorDelta: -2 },
      trajectory: { cost: "improving", errors: "stable" },
      anomalies: [{ severity: "warning", title: "Cost spike", detail: "Session cost is unusually high." }],
      deterministicFriction: {
        ongoing: [{ severity: "warning", title: "Tool errors", detail: "1 recent tool error signal detected." }],
        resolved: [{ severity: "info", title: "Slow responses", detail: "No recent slow response signals after 2 in the previous period." }],
      },
    },
    modelEfficiency: {
      generatedAt: "2025-03-16T00:00:00.000Z",
      models: [{ model: "opus", tokens: 2000, cost: 1, costPerToken: 0.0005, costPerMessage: 0.05, messages: 20, sessions: 2, avgSessionDuration: 45, toolErrorRate: 0.25 }],
      recommendations: ["Use opus for tasks that need higher capability."],
    },
    analysis: {
      generatedAt: "2025-03-16T00:00:00.000Z",
      takeaways: [{ severity: "info", title: "Primary project", detail: "project-a accounts for all recent work." }],
      recommendations: [{ title: "Checkpoint long conversations", detail: "Save plans and test commands before context gets noisy.", category: "workflow" }],
      stopDoing: [{ title: "Stop retrying failed tools blindly", detail: "Inspect the first failure before rerunning.", category: "stop" }],
    },
    ai: {
      status: "available",
      generatedAt: "2025-03-16T00:00:00.000Z",
      sourceRange: { start: "2025-03-01", end: "2025-03-15" },
      cacheState: "hit",
      facets: [],
      recommendations: [{ title: "Try cache", detail: "Use cached facets.", category: "workflow" }],
      stopDoing: [{ title: "Stop rerunning everything", detail: "Use refresh only when needed.", category: "stop" }],
    },
    ...overrides,
  };
}

describe("generateMarkdown", () => {
  it("renders deterministic report sections before available AI recommendations", () => {
    const markdown = generateMarkdown(makeAnalytics());

    expect(markdown).toMatchInlineSnapshot(`
      "# Pi Insights Report

      Generated: 2025-03-16T00:00:00.000Z

      Date range: 2025-03-01 to 2025-03-15

      ## Overview

      - Sessions: 2
      - Messages: 30
      - Tokens: 3,000
      - Cost: $1.25
      - Total duration: 1h 30m
      - Average session duration: 45m
      - Average messages/session: 15
      - Model-switching sessions: 1
      - Rage hits: 1

      ## Projects

      | Project | Sessions | Messages | Tokens | Cost | Duration |
      | --- | ---: | ---: | ---: | ---: | ---: |
      | project-a | 2 | 30 | 3,000 | $1.25 | 1h 30m |

      ## Models

      | Model | Messages | Tokens | Cost | Avg duration |
      | --- | ---: | ---: | ---: | ---: |
      | opus | 20 | 2,000 | $1.00 | 1h |
      | sonnet | 10 | 1,000 | $0.25 | 30m |

      ## Tools

      | Tool | Calls |
      | --- | ---: |
      | Read | 12 |
      | Bash\\|Shell | 3 |

      ## Temporal insights

      - Week over week (2025-03-08 vs 2025-03-01): sessions +1, cost -$0.50, tool errors -2.
      - Trajectory: cost improving; errors stable.
      - Decay-weighted activity: 1.75 sessions, 20 messages, 2,500 tokens, $0.90.

      ### Anomalies

      - warning: Cost spike — Session cost is unusually high.

      ### Ongoing friction

      - warning: Tool errors — 1 recent tool error signal detected.

      ### Resolved friction

      - info: Slow responses — No recent slow response signals after 2 in the previous period.

      ## Model efficiency

      | Model | Sessions | Messages | Tokens | Cost | Cost/token | Cost/message | Avg duration | Tool error rate |
      | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
      | opus | 2 | 20 | 2,000 | $1.00 | $0.0005 | $0.0500 | 45m | 25.0% |

      ### Model efficiency recommendations

      - Use opus for tasks that need higher capability.

      ## Analysis and recommendations

      ### Key takeaways

      - info: Primary project — project-a accounts for all recent work.

      ### Recommended next steps

      - Checkpoint long conversations (workflow) — Save plans and test commands before context gets noisy.

      ### Consider stopping

      - Stop retrying failed tools blindly (stop) — Inspect the first failure before rerunning.

      ## AI recommendations

      Status: available
      Source range: 2025-03-01 to 2025-03-15
      Cache: hit

      ### Recommendations

      - Try cache (workflow) — Use cached facets.

      ### Stop doing

      - Stop rerunning everything (stop) — Use refresh only when needed.
      "
    `);

    expect(markdown.indexOf("## Overview")).toBeLessThan(markdown.indexOf("## AI recommendations"));
    expect(markdown.indexOf("## Model efficiency")).toBeLessThan(markdown.indexOf("## AI recommendations"));
  });

  it("omits AI recommendations when AI insights are unavailable", () => {
    const markdown = generateMarkdown(makeAnalytics({
      ai: { status: "unavailable", cacheState: "skipped", unavailableReason: "No model", facets: [], recommendations: [{ title: "Hidden", detail: "Do not render" }], stopDoing: [] },
    }));

    expect(markdown).not.toContain("## AI recommendations");
    expect(markdown).not.toContain("Hidden");
  });

  it("renders AI recommendations when AI insights are partial", () => {
    const markdown = generateMarkdown(makeAnalytics({
      ai: { status: "partial", cacheState: "mixed", facets: [], recommendations: [{ title: "Partial", detail: "Some sessions failed." }], stopDoing: [] },
    }));

    expect(markdown).toContain("Status: partial");
    expect(markdown).toContain("Partial");
  });

  it("does not render arbitrary session transcript fields", () => {
    const analytics = makeAnalytics({
      sessions: [{ transcript: "secret transcript text" }] as unknown as Analytics["sessions"],
    });

    expect(generateMarkdown(analytics)).not.toContain("secret transcript text");
  });
});
