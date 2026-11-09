import { describe, it, expect } from "vitest";
import { writeFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionEvents, parseSessionTranscript, sliceParsedSession } from "../src/parser.js";
import { sliceParsedSession as sliceRange } from "../src/slicing.js";
import type { SessionEvent } from "../src/types.js";

async function parseSessionFile(filePath: string) {
  try {
    return parseSessionTranscript(await readFile(filePath, "utf8"), filePath);
  } catch {
    return null;
  }
}

async function writeTempJsonl(lines: object[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-insights-test-"));
  const filePath = join(dir, "test-session.jsonl");
  await writeFile(filePath, lines.map(l => JSON.stringify(l)).join("\n") + "\n", "utf-8");
  return filePath;
}

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}

describe("parseSessionFile", () => {
  it("returns null for a non-existent file", async () => {
    const result = await parseSessionFile("/tmp/does-not-exist-abc123.jsonl");
    expect(result).toBeNull();
  });

  it("returns null for a file with no valid session start", async () => {
    const filePath = await writeTempJsonl([
      { type: "garbage", foo: "bar" },
    ]);
    const result = await parseSessionFile(filePath);
    expect(result).toBeNull();
  });

  it("parses a minimal valid session", async () => {
    const filePath = await writeTempJsonl([
      { type: "session", id: "sess-abc", cwd: "/home/user/myapp", timestamp: "2025-03-15T10:00:00.000Z" },
      { type: "message", timestamp: "2025-03-15T10:05:00.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
      { type: "message", timestamp: "2025-03-15T10:06:00.000Z", message: { role: "assistant", content: [], usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.001 } } } },
    ]);
    const result = await parseSessionFile(filePath);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("sess-abc");
    expect(result!.cwd).toBe("/home/user/myapp");
    expect(result!.projectName).toBe("myapp");
    expect(result!.userMessageCount).toBe(1);
    expect(result!.assistantMessageCount).toBe(1);
    expect(result!.messageCount).toBe(2);
  });

  it("uses filename as id when session event has no id", async () => {
    const filePath = await writeTempJsonl([
      { type: "session", cwd: "/home/user/app", timestamp: "2025-03-15T10:00:00.000Z" },
      { type: "message", timestamp: "2025-03-15T10:01:00.000Z", message: { role: "user", content: [] } },
    ]);
    const result = await parseSessionFile(filePath);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("test-session");
  });

  it("computes duration from first to last event timestamp", async () => {
    const filePath = await writeTempJsonl([
      { type: "session", id: "s1", cwd: "/a", timestamp: "2025-03-15T10:00:00.000Z" },
      { type: "message", timestamp: "2025-03-15T10:00:00.000Z", message: { role: "user", content: [] } },
      { type: "message", timestamp: "2025-03-15T10:30:00.000Z", message: { role: "assistant", content: [] } },
    ]);
    const result = await parseSessionFile(filePath);
    expect(result!.duration).toBe(30);
  });

  it("aggregates token usage from assistant messages", async () => {
    const filePath = await writeTempJsonl([
      { type: "session", id: "s1", cwd: "/a", timestamp: "2025-03-15T10:00:00.000Z" },
      { type: "message", timestamp: "2025-03-15T10:01:00.000Z", message: { role: "user", content: [] } },
      {
        type: "message",
        timestamp: "2025-03-15T10:02:00.000Z",
        message: {
          role: "assistant",
          content: [],
          model: "gpt-4",
          usage: { input: 200, output: 100, cacheRead: 50, cacheWrite: 0, totalTokens: 350, cost: { input: 0.002, output: 0.001, cacheRead: 0.0005, cacheWrite: 0, total: 0.0035 } },
        },
      },
    ]);
    const result = await parseSessionFile(filePath);
    expect(result!.tokenUsage.input).toBe(200);
    expect(result!.tokenUsage.output).toBe(100);
    expect(result!.tokenUsage.cacheRead).toBe(50);
    expect(result!.tokenUsage.total).toBe(350);
    expect(result!.cost.total).toBeCloseTo(0.0035);
  });

  it("slices a resumed session by assistant-turn timestamps", async () => {
    const filePath = await writeTempJsonl([
      { type: "session", id: "s1", cwd: "/a", timestamp: "2025-03-14T23:59:00.000Z" },
      { type: "message", timestamp: "2025-03-14T23:59:30.000Z", message: { role: "assistant", model: "gpt-4", content: [], usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 1 } } } },
      { type: "message", timestamp: "2025-03-15T00:00:00.000Z", message: { role: "assistant", model: "gpt-4", content: [], usage: { input: 30, output: 40, totalTokens: 70, cost: { total: 2 } } } },
      { type: "message", timestamp: "2025-03-15T01:00:00.000Z", message: { role: "assistant", model: "gpt-4", content: [], usage: { input: 50, output: 60, totalTokens: 110, cost: { total: 3 } } } },
    ]);
    const parsed = await parseSessionFile(filePath);
    const sliced = sliceParsedSession(parsed!, new Date("2025-03-15T00:00:00.000Z"), new Date("2025-03-15T01:00:00.000Z"));
    expect(sliced?.assistantMessageCount).toBe(1);
    expect(sliced?.tokenUsage.total).toBe(70);
    expect(sliced?.cost.total).toBe(2);
    expect(sliced?.startTime.toISOString()).toBe("2025-03-15T00:00:00.000Z");
  });

  it("tracks model changes and links them to token usage", async () => {
    const filePath = await writeTempJsonl([
      { type: "session", id: "s1", cwd: "/a", timestamp: "2025-03-15T10:00:00.000Z" },
      { type: "model_change", modelId: "gpt-4", provider: "openai", timestamp: "2025-03-15T10:00:01.000Z" },
      { type: "model_change", modelId: "gpt-4", provider: "openai", timestamp: "2025-03-15T10:00:02.000Z" },
      { type: "message", timestamp: "2025-03-15T10:01:00.000Z", message: { role: "user", content: [] } },
      { type: "message", timestamp: "2025-03-15T10:02:00.000Z", message: { role: "assistant", model: "gpt-4", provider: "openai", content: [], usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.001 } } } },
    ]);
    const result = await parseSessionFile(filePath);
    expect(result!.models["gpt-4"]).toBeDefined();
    expect(result!.models["gpt-4"].count).toBe(1);
    expect(result!.models["gpt-4"].tokens).toBe(150);
    expect(result!.providers["openai"]).toBe(1);
  });

  it("counts tool calls from content items", async () => {
    const filePath = await writeTempJsonl([
      { type: "session", id: "s1", cwd: "/a", timestamp: "2025-03-15T10:00:00.000Z" },
      { type: "message", timestamp: "2025-03-15T10:01:00.000Z", message: { role: "user", content: [] } },
      {
        type: "message",
        timestamp: "2025-03-15T10:02:00.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", name: "Read" },
            { type: "toolCall", name: "Read" },
            { type: "toolCall", name: "Write" },
          ],
        },
      },
    ]);
    const result = await parseSessionFile(filePath);
    expect(result!.toolCallCount).toBe(3);
    expect(result!.toolUsage["Read"]).toBe(2);
    expect(result!.toolUsage["Write"]).toBe(1);
  });

  it("detects tool errors and sets hasError", async () => {
    const filePath = await writeTempJsonl([
      { type: "session", id: "s1", cwd: "/a", timestamp: "2025-03-15T10:00:00.000Z" },
      { type: "message", timestamp: "2025-03-15T10:01:00.000Z", message: { role: "user", content: [] } },
      {
        type: "message",
        timestamp: "2025-03-15T10:02:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolResult", isError: true }],
        },
      },
    ]);
    const result = await parseSessionFile(filePath);
    expect(result!.toolCallErrors).toBe(1);
    expect(result!.hasError).toBe(true);
  });

  it("detects rage hits in user messages", async () => {
    const filePath = await writeTempJsonl([
      { type: "session", id: "s1", cwd: "/a", timestamp: "2025-03-15T10:00:00.000Z" },
      { type: "model_change", modelId: "gpt-4", provider: "openai", timestamp: "2025-03-15T10:00:01.000Z" },
      {
        type: "message",
        timestamp: "2025-03-15T10:01:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "what the fuck is going on" }] },
      },
      { type: "message", timestamp: "2025-03-15T10:02:00.000Z", message: { role: "assistant", content: [] } },
    ]);
    const result = await parseSessionFile(filePath);
    expect(result!.rageHits).toHaveLength(1);
    expect(result!.rageHits[0].word).toBe("fuck");
    expect(result!.rageHits[0].group).toBe("fuck");
    expect(result!.rageHits[0].model).toBe("gpt-4");
    expect(result!.rageHits[0].msgIndex).toBe(1);
  });

  it("does not detect rage in assistant messages", async () => {
    const filePath = await writeTempJsonl([
      { type: "session", id: "s1", cwd: "/a", timestamp: "2025-03-15T10:00:00.000Z" },
      { type: "message", timestamp: "2025-03-15T10:01:00.000Z", message: { role: "user", content: [] } },
      {
        type: "message",
        timestamp: "2025-03-15T10:02:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "this code is bullshit" }] },
      },
    ]);
    const result = await parseSessionFile(filePath);
    expect(result!.rageHits).toHaveLength(0);
  });

  it("skips malformed JSON lines without crashing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-insights-test-"));
    const filePath = join(dir, "test-session.jsonl");
    const lines = [
      JSON.stringify({ type: "session", id: "s1", cwd: "/a", timestamp: "2025-03-15T10:00:00.000Z" }),
      "this is not json {{{",
      JSON.stringify({ type: "message", timestamp: "2025-03-15T10:01:00.000Z", message: { role: "user", content: [] } }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");
    const result = await parseSessionFile(filePath);
    expect(result).not.toBeNull();
    expect(result!.userMessageCount).toBe(1);
  });

  it("extracts deterministic timing and activity metadata", async () => {
    const filePath = await writeTempJsonl([
      { type: "session", id: "s1", cwd: "/repo", timestamp: "2025-03-15T10:00:00.000Z" },
      { type: "message", timestamp: "2025-03-15T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "please help with the app" }] } },
      { type: "message", timestamp: "2025-03-15T10:00:03.000Z", message: { role: "assistant", model: "gpt-4", content: [], usage: { input: 10, output: 20, totalTokens: 30 } } },
      { type: "message", timestamp: "2025-03-15T11:00:00.000Z", message: { role: "user", content: [] } },
      { type: "message", timestamp: "2025-03-15T11:00:07.000Z", message: { role: "assistant", model: "gpt-4", content: [], usage: { input: 10, output: 20, totalTokens: 30 } } },
    ]);

    const result = await parseSessionFile(filePath);

    expect(result!.metadata?.primaryModel).toBe("gpt-4");
    expect(result!.metadata?.responseTimesMs).toEqual([3000, 7000]);
    expect(result!.metadata?.avgResponseTimeMs).toBe(5000);
    const hour10 = String(new Date("2025-03-15T10:00:00.000Z").getHours());
    const hour11 = String(new Date("2025-03-15T11:00:00.000Z").getHours());
    expect(result!.metadata?.activityByHour).toEqual({ [hour10]: 2, [hour11]: 2 });
  });

  it("extracts file, language, git, interruption, and tool-error metadata without storing transcript text", async () => {
    const filePath = await writeTempJsonl([
      { type: "session", id: "s1", cwd: "/repo", timestamp: "2025-03-15T10:00:00.000Z" },
      { type: "message", timestamp: "2025-03-15T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "secret transcript text" }] } },
      {
        type: "message",
        timestamp: "2025-03-15T10:00:03.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", name: "Write", input: { file_path: "src/App.tsx" } },
            { type: "toolCall", name: "Bash", input: { command: "git status && git diff && git commit -m test && git push" } },
            { type: "toolResult", name: "Write", isError: true },
          ],
          stopReason: "interrupted",
        },
      },
      { type: "user_interrupt", timestamp: "2025-03-15T10:00:04.000Z" },
    ]);

    const result = await parseSessionFile(filePath);

    expect(result!.toolCallCount).toBe(2);
    expect(result!.toolCallErrors).toBe(1);
    expect(result!.metadata?.filesMentioned).toEqual(["src/App.tsx"]);
    expect(result!.metadata?.languageCounts).toEqual({ TypeScript: 1 });
    expect(result!.metadata?.gitActivity).toEqual({ commits: 1, pushes: 1, statusChecks: 1, diffs: 1 });
    expect(result!.metadata?.toolErrorsByName).toEqual({ Write: 1 });
    expect(result!.metadata?.userInterruptions).toBe(2);
    expect(JSON.stringify(result)).not.toContain("secret transcript text");
    const events = (await readFile(filePath, "utf8")).trim().split("\n").map(line => JSON.parse(line) as SessionEvent);
    expect(parseSessionEvents(events, filePath)).toEqual(result);
    deepFreeze(events);
    expect(parseSessionEvents(events, filePath)).toEqual(result);
  });
});

describe("range metrics", () => {
  const RANGE_START = new Date("2025-03-15T00:00:00.000Z");
  const RANGE_END = new Date("2025-03-16T00:00:00.000Z");
  const parse = (lines: object[]) => parseSessionTranscript(lines.map(line => JSON.stringify(line)).join("\n"), "s1")!;

  it("keeps rage hits and thinking-level changes when a range slices the session", () => {
    const session = parse([
      { type: "session", id: "s1", cwd: "/a", timestamp: "2025-03-15T10:00:00.000Z" },
      { type: "thinking_level_change", id: "t1", thinkingLevel: "high", timestamp: "2025-03-15T10:00:01.000Z" },
      { type: "message", id: "u1", timestamp: "2025-03-15T10:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "what the fuck is going on" }] } },
    ]);
    const sliced = sliceRange(session, RANGE_START, RANGE_END)!;
    expect(sliced.rageHits.length).toBeGreaterThan(0);
    expect(sliced.rageHits).toEqual(session.rageHits);
    expect(sliced.thinkingLevels).toEqual({ high: 1 });
    expect(sliceRange(session, RANGE_END)).toBeNull();
  });

  it("includes cache writes in token totals when totalTokens is absent", () => {
    const session = parse([
      { type: "session", id: "s1", cwd: "/a", timestamp: "2025-03-15T10:00:00.000Z" },
      { type: "message", timestamp: "2025-03-15T10:01:00.000Z", message: { role: "assistant", model: "m", content: [], usage: { input: 1, output: 2, cacheRead: 4, cacheWrite: 8 } } },
    ]);
    expect(session.tokenUsage.total).toBe(15);
    expect(session.models.m!.tokens).toBe(15);
    expect(sliceRange(session, RANGE_START, RANGE_END)!.tokenUsage.total).toBe(15);
  });

  it("counts assistant messages per model, not model_change events, before and after slicing", () => {
    const session = parse([
      { type: "session", id: "s1", cwd: "/a", timestamp: "2025-03-15T10:00:00.000Z" },
      { type: "model_change", modelId: "a", timestamp: "2025-03-15T10:00:01.000Z" },
      { type: "model_change", modelId: "b", timestamp: "2025-03-15T10:00:02.000Z" },
      { type: "message", timestamp: "2025-03-15T10:01:00.000Z", message: { role: "assistant", model: "b", content: [] } },
      { type: "message", timestamp: "2025-03-15T10:02:00.000Z", message: { role: "assistant", model: "b", content: [], usage: { input: 1, output: 1 } } },
    ]);
    expect(session.models).toEqual({ b: { count: 2, tokens: 2, cost: 0 } });
    expect(sliceRange(session, RANGE_START, RANGE_END)!.models).toEqual(session.models);
  });

  it("charges tool errors to the model that made the call", () => {
    const session = parse([
      { type: "session", id: "s1", cwd: "/a", timestamp: "2025-03-15T10:00:00.000Z" },
      { type: "message", timestamp: "2025-03-15T10:01:00.000Z", message: { role: "assistant", model: "a", content: [{ type: "toolCall", id: "call-a", name: "bash", arguments: {} }], usage: { input: 1, output: 1 } } },
      { type: "message", timestamp: "2025-03-15T10:02:00.000Z", message: { role: "assistant", model: "b", content: [{ type: "toolCall", id: "call-b", name: "read", arguments: {} }], usage: { input: 1, output: 1 } } },
      { type: "message", timestamp: "2025-03-15T10:03:00.000Z", message: { role: "toolResult", toolCallId: "call-b", toolName: "read", content: [], isError: false } },
      { type: "message", timestamp: "2025-03-15T10:04:00.000Z", message: { role: "toolResult", toolCallId: "call-a", toolName: "bash", content: [], isError: true } },
    ]);
    expect(session.toolCallErrors).toBe(1);
    expect(session.metadata?.toolErrorsByName).toEqual({ bash: 1 });
    expect(session.models.a!.toolErrors).toBe(1);
    expect(session.models.b!.toolErrors).toBeUndefined();
    const sliced = sliceRange(session, RANGE_START, RANGE_END)!;
    expect(sliced.toolCallErrors).toBe(1);
    expect(sliced.models).toEqual({ a: { count: 1, tokens: 2, cost: 0, toolErrors: 1 }, b: { count: 1, tokens: 2, cost: 0 } });
  });
});
