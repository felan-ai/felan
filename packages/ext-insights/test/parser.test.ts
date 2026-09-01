import { describe, it, expect, afterEach } from "vitest";
import { writeFile, unlink, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionTranscript, sliceParsedSession } from "../src/parser.js";

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
      { type: "message", timestamp: "2025-03-15T10:01:00.000Z", message: { role: "user", content: [] } },
      { type: "message", timestamp: "2025-03-15T10:02:00.000Z", message: { role: "assistant", model: "gpt-4", content: [], usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.001 } } } },
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
  });
});
