import { describe, it, expect } from "vitest";
import { getInsightsArgumentCompletions, getSinceCutoff, parseInsightsArgs } from "../src/cli.js";

describe("parseInsightsArgs", () => {
  it("uses the current no-arg defaults", () => {
    const result = parseInsightsArgs("");
    expect(result).toEqual({
      ok: true,
      options: {
        openReport: true,
        refresh: false,
        markdown: false,
      },
    });
  });

  it("parses supported flags", () => {
    const result = parseInsightsArgs("--no-open --since 30d --refresh --md");
    expect(result).toEqual({
      ok: true,
      options: {
        openReport: false,
        sinceDays: 30,
        refresh: true,
        markdown: true,
      },
    });
  });

  it("parses -r as a refresh alias", () => {
    const result = parseInsightsArgs("-r");
    expect(result).toEqual({
      ok: true,
      options: {
        openReport: true,
        refresh: true,
        markdown: false,
      },
    });
  });

  it("rejects unknown flags", () => {
    const result = parseInsightsArgs("--wat");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Unknown option");
  });

  it("rejects unexpected positional arguments", () => {
    const result = parseInsightsArgs("project-a");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Unexpected argument");
  });

  it("rejects missing --since values", () => {
    const result = parseInsightsArgs("--since");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Missing value");
  });

  it("rejects invalid --since values", () => {
    for (const value of ["0d", "7", "7days", "-1d"]) {
      const result = parseInsightsArgs(`--since ${value}`);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("Invalid --since value");
    }
  });
});

describe("getSinceCutoff", () => {
  it("returns undefined without a since filter", () => {
    expect(getSinceCutoff({ openReport: true, refresh: false, markdown: false })).toBeUndefined();
  });

  it("computes the day cutoff", () => {
    const cutoff = getSinceCutoff(
      { openReport: true, sinceDays: 7, refresh: false, markdown: false },
      new Date("2025-03-15T12:00:00Z")
    );
    expect(cutoff?.toISOString()).toBe("2025-03-08T12:00:00.000Z");
  });
});

describe("getInsightsArgumentCompletions", () => {
  it("returns supported flags", () => {
    expect(getInsightsArgumentCompletions("").map(item => item.value)).toContain("--no-open");
    expect(getInsightsArgumentCompletions("").map(item => item.value)).toContain("--since");
  });

  it("filters by the current token", () => {
    expect(getInsightsArgumentCompletions("--no").map(item => item.value)).toEqual(["--no-open"]);
  });
});
