import { describe, it, expect } from "vitest";
import { detectRage, RAGE_WORDLIST, wordCount } from "../src/rage.js";

describe("detectRage", () => {
  it("returns empty array for clean text", () => {
    expect(detectRage("hello world, everything is fine")).toEqual([]);
  });

  it("detects a single swear word", () => {
    const hits = detectRage("what the fuck is going on");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({ word: "fuck", group: "fuck" });
  });

  it("detects multiple swear words in one message", () => {
    const hits = detectRage("this is bullshit and I'm damn sure about it");
    expect(hits).toHaveLength(2);
    expect(hits.map(h => h.word)).toContain("bullshit");
    expect(hits.map(h => h.word)).toContain("damn");
  });

  it("is case-insensitive", () => {
    expect(detectRage("FUCK this")).toHaveLength(1);
    expect(detectRage("Shit happens")).toHaveLength(1);
    expect(detectRage("WTF")).toHaveLength(1);
  });

  it("returns lowercase word regardless of input case", () => {
    const hits = detectRage("FUCK this");
    expect(hits[0].word).toBe("fuck");
  });

  it("does not match partial words", () => {
    // 'class' does not contain \bass\b
    expect(detectRage("class assignment")).toEqual([]);
    // 'shell' does not trigger 'hell' with boundary
    expect(detectRage("shell script")).toEqual([]);
  });

  it("does match word boundaries correctly", () => {
    expect(detectRage("this is hell")).toHaveLength(1);
    expect(detectRage("hell yeah")).toHaveLength(1);
  });

  it("assigns correct groups", () => {
    const cases: [string, string][] = [
      ["fuck",     "fuck"],
      ["bullshit", "shit"],
      ["asshole",  "ass"],
      ["damn",     "damn"],
      ["bitch",    "bitch"],
      ["bastard",  "bastard"],
      ["piss",     "piss"],
      ["dick",     "dick"],
      ["crap",     "crap"],
      ["hell",     "hell"],
      ["wtf",      "wtf"],
      ["cunt",     "cunt"],
    ];
    for (const [word, group] of cases) {
      const hits = detectRage(word);
      expect(hits, `expected "${word}" → group "${group}"`).toHaveLength(1);
      expect(hits[0].group).toBe(group);
    }
  });

  it("detects compound words", () => {
    expect(detectRage("motherfucker")).toHaveLength(1);
    expect(detectRage("clusterfuck")).toHaveLength(1);
    expect(detectRage("goddammit")).toHaveLength(1);
  });

  it("counts multiple occurrences of the same word", () => {
    const hits = detectRage("wtf wtf wtf");
    expect(hits).toHaveLength(3);
    expect(hits.every(h => h.word === "wtf")).toBe(true);
  });

  it("handles empty string", () => {
    expect(detectRage("")).toEqual([]);
  });

  it("handles text with only punctuation", () => {
    expect(detectRage("... !!! ???")).toEqual([]);
  });

  it("is safe to call multiple times (no shared state mutation)", () => {
    const first = detectRage("fuck this shit");
    const second = detectRage("fuck this shit");
    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
  });
});

describe("RAGE_WORDLIST", () => {
  it("contains at least 30 entries", () => {
    expect(wordCount()).toBeGreaterThanOrEqual(30);
  });

  it("has no duplicate words", () => {
    const words = RAGE_WORDLIST.map(w => w.word.toLowerCase());
    const unique = new Set(words);
    expect(unique.size).toBe(words.length);
  });

  it("every entry has a non-empty word and group", () => {
    for (const entry of RAGE_WORDLIST) {
      expect(entry.word).toBeTruthy();
      expect(entry.group).toBeTruthy();
    }
  });
});
