import type { Model, SessionEntry } from '@felan-ai/agent-core';
import { describe, expect, it } from 'vitest';
import { promptCacheState } from '../src/internal/cache-state.js';

const refreshedAt = Date.parse('2026-01-01T00:00:00.000Z');
type AssistantMessage = Extract<Extract<SessionEntry, { type: 'message' }>['message'], { role: 'assistant' }>;

function assistant(
  usage: Partial<AssistantMessage['usage']> = { cacheRead: 1 },
  message: Partial<AssistantMessage> = {},
): SessionEntry {
  return {
    type: 'message', id: 'reply', parentId: null, timestamp: new Date(refreshedAt).toISOString(),
    message: {
      role: 'assistant', api: 'openai-responses', provider: 'test', model: 'test', content: [],
      timestamp: refreshedAt, stopReason: 'stop',
      usage: {
        input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        ...usage,
      },
      ...message,
    },
  };
}

function model(overrides: Partial<Model<any>> = {}): Model<any> {
  return {
    id: 'test', name: 'Test', api: 'openai-responses', provider: 'test', baseUrl: 'https://example.test',
    input: ['text'], reasoning: false, contextWindow: 100_000, maxTokens: 1_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

function cacheWarm(timestamp: number): SessionEntry {
  return {
    type: 'usage', id: 'warm', parentId: null, timestamp: new Date(timestamp).toISOString(),
    kind: 'cache_warm', provider: 'test', model: 'test',
    usage: {
      input: 0, output: 0, totalTokens: 0, cacheRead: 1, cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

describe('prompt cache state', () => {
  it('starts uncached without a model or entries', () => {
    expect(promptCacheState(undefined, [])).toEqual({ cached: false });
  });

  it.each([{ cacheRead: 1 }, { cacheWrite: 1 }])('tracks cache usage %j at the assistant timestamp', (usage) => {
    expect(promptCacheState(undefined, [assistant(usage)])).toEqual({ cached: true, refreshedAt });
    expect(promptCacheState(undefined, [assistant(usage, { timestamp: 0 })])).toEqual({ cached: true, refreshedAt: 0 });
  });

  it('uses the latest successful reply and clears cache state for a cache miss', () => {
    const later = refreshedAt + 20_000;
    expect(promptCacheState(undefined, [assistant(), assistant({ cacheRead: 2 }, { timestamp: later })]))
      .toEqual({ cached: true, refreshedAt: later });
    expect(promptCacheState(undefined, [assistant(), assistant({ cacheRead: 0, cacheWrite: 0 })]))
      .toEqual({ cached: false });
  });

  it('resets refresh time and reported tier at compaction', () => {
    const write = assistant({ cacheWrite: 10, cacheWrite1h: 10 });
    const compaction: SessionEntry = {
      type: 'compaction', id: 'compact', parentId: null, timestamp: new Date(refreshedAt).toISOString(),
      summary: 'Summary', firstKeptEntryId: 'keep', tokensBefore: 100,
    };
    expect(promptCacheState(undefined, [write, compaction, cacheWarm(refreshedAt + 1_000)]))
      .toEqual({ cached: false });
    expect(promptCacheState(undefined, [write, compaction, assistant()]))
      .toEqual({ cached: true, refreshedAt });
    expect(promptCacheState(model({ promptCache: { short: 60, long: 120 } }), [write, compaction]))
      .toEqual({ cached: false, lifetimeMs: 60_000, lifetimeSource: 'declared' });
  });

  it.each(['error', 'aborted'] as const)('does not refresh or clear for %s replies', (stopReason) => {
    for (const usage of [{ cacheRead: 0 }, { cacheWrite: 1 }]) {
      const failed = assistant(usage, { stopReason, timestamp: refreshedAt + 10_000 });
      expect(promptCacheState(undefined, [failed])).toEqual({ cached: false });
      expect(promptCacheState(undefined, [assistant(), failed])).toEqual({ cached: true, refreshedAt });
    }
  });

  it('retains a tier reported by a failed reply without refreshing cache time', () => {
    expect(promptCacheState(undefined, [assistant(), assistant(
      { cacheWrite: 5, cacheWrite1h: 5 }, { stopReason: 'error', timestamp: refreshedAt + 10_000 },
    )])).toEqual({
      cached: true, refreshedAt, lifetimeMs: 3_600_000, lifetimeSource: 'reported', expiresAt: refreshedAt + 3_600_000,
    });
  });

  it('extends only an existing cache with cache_warm entries and never moves it backward', () => {
    const later = refreshedAt + 30_000;
    expect(promptCacheState(undefined, [cacheWarm(later)])).toEqual({ cached: false });
    expect(promptCacheState(undefined, [assistant(), cacheWarm(later), cacheWarm(refreshedAt)]))
      .toEqual({ cached: true, refreshedAt: later });
    expect(promptCacheState(undefined, [assistant(), assistant({}), cacheWarm(later)]))
      .toEqual({ cached: false });
    expect(promptCacheState(model({ promptCache: { short: 60 } }), [assistant(), cacheWarm(later)]))
      .toMatchObject({ refreshedAt: later, expiresAt: later + 60_000 });
  });

  it.each([
    [{ cacheRead: 1 }, 60_000],
    [{ cacheWrite: 10 }, 60_000],
    [{ cacheWrite: 10, cacheWrite1h: 0 }, 60_000],
    [{ cacheWrite: 10, cacheWrite1h: 1 }, 120_000],
    [{ cacheRead: 10, cacheWrite1h: 1 }, 60_000],
  ])('prefers declared lifetimes using the last reported tier: %j', (usage, lifetimeMs) => {
    expect(promptCacheState(model({ promptCache: { short: 60, long: 120 } }), [assistant(usage)]))
      .toEqual({ cached: true, refreshedAt, lifetimeMs, lifetimeSource: 'declared', expiresAt: refreshedAt + lifetimeMs });
  });

  it.each([[0, 300_000], [1, 3_600_000]])('uses a reported tier without a declaration: %s', (cacheWrite1h, lifetimeMs) => {
    expect(promptCacheState(undefined, [assistant({ cacheWrite: 10, cacheWrite1h })]))
      .toEqual({ cached: true, refreshedAt, lifetimeMs, lifetimeSource: 'reported', expiresAt: refreshedAt + lifetimeMs });
  });

  it('keeps the reported tier through reads and replaces it on the next reported write', () => {
    const write = assistant({ cacheWrite: 10, cacheWrite1h: 1 });
    expect(promptCacheState(undefined, [write, assistant()])).toMatchObject({ lifetimeMs: 3_600_000 });
    expect(promptCacheState(undefined, [write, assistant({ cacheWrite: 1, cacheWrite1h: 0 })]))
      .toMatchObject({ lifetimeMs: 300_000 });
    expect(promptCacheState(model({ promptCache: { short: 60 } }), [write]))
      .toMatchObject({ lifetimeMs: 3_600_000, lifetimeSource: 'reported' });
  });

  it('keeps lifetime unknown for explicit openai-responses cache mode', () => {
    const explicit = model({ compat: { supportsExplicitPromptCacheMode: true } });
    const state = promptCacheState(explicit, [assistant()]);
    expect(state).toEqual({ cached: true, refreshedAt });
    expect(promptCacheState(model(), [assistant()])).toEqual({ cached: true, refreshedAt });
    expect(promptCacheState(model({ compat: { supportsExplicitPromptCacheMode: false } }), [assistant()]))
      .toEqual({ cached: true, refreshedAt });
    expect(promptCacheState(model({ ...explicit, api: 'openai-codex-responses' }), [assistant()]))
      .toEqual({ cached: true, refreshedAt });
    expect(promptCacheState(model({ ...explicit, promptCache: { short: 0 } }), [assistant()]))
      .toMatchObject({ lifetimeMs: 0, lifetimeSource: 'declared', expiresAt: refreshedAt });
    expect(promptCacheState(explicit, [assistant({ cacheWrite: 1, cacheWrite1h: 0 })]))
      .toMatchObject({ lifetimeMs: 300_000, lifetimeSource: 'reported' });
  });

  it('ignores malformed entries and unrelated message or usage kinds', () => {
    const malformed: unknown[] = [
      null, undefined, 1, 'message', [], {}, { type: 'message' }, { type: 'message', message: null },
      { type: 'message', message: { role: 'assistant' } },
      { type: 'message', message: { role: 'user', timestamp: refreshedAt + 100_000 } },
      { ...cacheWarm(refreshedAt + 100_000), kind: 'other' },
      { ...cacheWarm(refreshedAt + 100_000), timestamp: 'not a date' },
      { ...cacheWarm(refreshedAt + 100_000), timestamp: 100_000 },
      { ...cacheWarm(refreshedAt + 100_000), timestamp: null },
    ];
    for (const usage of [null, [], {}, { cacheRead: '1', cacheWrite: 0 }, { cacheRead: -1, cacheWrite: 0 },
      { cacheRead: 0, cacheWrite: NaN }, { cacheRead: Infinity, cacheWrite: 0 },
      { cacheRead: 0, cacheWrite: 1, cacheWrite1h: '1' }, { cacheRead: 0, cacheWrite: 1, cacheWrite1h: -1 }]) {
      const entry = assistant();
      if (entry.type === 'message') malformed.push({ ...entry, message: { ...entry.message, usage } });
    }
    for (const patch of [{ timestamp: 'later' }, { timestamp: NaN }, { timestamp: Infinity }, { stopReason: null }]) {
      const entry = assistant();
      if (entry.type === 'message') malformed.push({ ...entry, message: { ...entry.message, ...patch } });
    }
    const entries = malformed as SessionEntry[];
    expect(promptCacheState(undefined, entries)).toEqual({ cached: false });
    expect(promptCacheState(undefined, [assistant(), ...entries])).toEqual({ cached: true, refreshedAt });
  });

  it.each([NaN, Infinity, -1])('ignores invalid declared lifetimes: %s', (short) => {
    expect(promptCacheState(model({ promptCache: { short } }), [assistant()]))
      .toEqual({ cached: true, refreshedAt });
  });
});

