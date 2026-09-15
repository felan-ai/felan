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
      markdownPath: "/reports/felan-insights.md",
    },
    modelEfficiency: {
      generatedAt: "2025-03-16T00:00:00.000Z",
      models: [{ model: "opus", tokens: 2000, cost: 1, costPerToken: 0.0005, costPerMessage: 0.05, messages: 20, sessions: 2, avgSessionDuration: 45, toolErrorRate: 0.25 }],
    },
    ...overrides,
  };
}

describe("generateMarkdown", () => {
  it("renders factual report sections", () => {
    const markdown = generateMarkdown(makeAnalytics());

    expect(markdown).toMatchInlineSnapshot(`
      "# Felan Code Insights Report

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

      ### Efficiency

      | Model | Sessions | Messages | Tokens | Cost | Cost/token | Cost/message | Avg duration | Tool error rate |
      | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
      | opus | 2 | 20 | 2,000 | $1.00 | $0.0005 | $0.0500 | 45m | 25.0% |

      ## Tools

      | Tool | Calls |
      | --- | ---: |
      | Read | 12 |
      | Bash\\|Shell | 3 |
      "
    `);

    expect(markdown).not.toContain("Temporal insights");
    expect(markdown).not.toContain("recommendations");
    expect(markdown).not.toContain("## Model efficiency");
  });

  it("does not render arbitrary session transcript fields", () => {
    const analytics = makeAnalytics({
      sessions: [{ transcript: "secret transcript text" }] as unknown as Analytics["sessions"],
    });

    expect(generateMarkdown(analytics)).not.toContain("secret transcript text");
  });
});
