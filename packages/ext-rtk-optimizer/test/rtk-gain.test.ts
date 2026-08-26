import { describe, expect, it } from 'vitest';
import {
  createRtkGainSegment,
  discoverRtkGainSegments,
  discardRtkGainSegment,
  parseRtkGainSummary,
  readRtkGainSegment,
  wrapCommandWithRtkGain,
} from '../src/rtk-gain.js';
import { MemoryRuntime, result } from './test-runtime.js';

const NOW = 1_700_000_000_000;

describe('session RTK gain segments', () => {
  it('reuses one database per model and safely wraps rewrites', async () => {
    const runtime = new MemoryRuntime(undefined, '/agent storage');
    const first = await createRtkGainSegment(runtime, { provider: 'openai', id: 'gpt-4o' }, { now: () => NOW });
    const second = await createRtkGainSegment(runtime, { provider: 'openai', id: 'gpt-4o' }, { now: () => NOW });
    const other = await createRtkGainSegment(runtime, { provider: 'anthropic', id: 'claude' }, { now: () => NOW });

    expect(second?.databasePath).toBe(first?.databasePath);
    expect(other?.databasePath).not.toBe(first?.databasePath);
    expect([...runtime.files.keys()]).toEqual(expect.arrayContaining([
      first!.relativeManifestPath,
      other!.relativeManifestPath,
    ]));
    expect(wrapCommandWithRtkGain("rtk git status && printf '%s' ok", first!)).toBe(
      `(RTK_DB_PATH='${first!.databasePath}'; export RTK_DB_PATH; rtk git status && printf '%s' ok\n\n)`,
    );
  });

  it('quotes apostrophes in the database path', async () => {
    const runtime = new MemoryRuntime(undefined, "/agent's storage");
    const capture = await createRtkGainSegment(runtime, undefined, { now: () => NOW });

    expect(wrapCommandWithRtkGain('rtk git status', capture!)).toContain(
      `RTK_DB_PATH='/agent'\\''s storage/rtk-optimizer/gain/`,
    );
  });

  it('does not attempt POSIX capture on Windows runtimes', async () => {
    const runtime = new MemoryRuntime(undefined, 'C:\\agent-storage');

    await expect(createRtkGainSegment(runtime, undefined)).resolves.toBeUndefined();
    expect(runtime.files.size).toBe(0);
  });

  it('reads only the session database with bounded literal argv and leaves cleanup explicit', async () => {
    const runtime = new MemoryRuntime(async () => result(JSON.stringify({
      summary: {
        total_commands: 2,
        total_input: 100,
        total_output: 25,
        total_saved: 75,
        avg_savings_pct: 75,
        total_time_ms: 5,
        avg_time_ms: 2,
      },
    })));
    const capture = await createRtkGainSegment(runtime, undefined, { now: () => NOW });
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      runtime.files.set(`${capture!.relativeDatabasePath}${suffix}`, new Uint8Array([1]));
    }

    await expect(readRtkGainSegment(runtime, '/managed/rtk', capture!)).resolves.toEqual({
      calls: 2,
      inputTokens: 100,
      outputTokens: 25,
    });
    expect(runtime.execCalls).toEqual([{
      command: '/usr/bin/env',
      args: [`RTK_DB_PATH=${capture!.databasePath}`, '/managed/rtk', 'gain', '--format', 'json'],
      options: { timeout: 5_000, maxOutputBytes: 64 * 1_024 },
    }]);
    expect([...runtime.files.keys()]).toEqual(expect.arrayContaining([
      capture!.relativeDatabasePath,
      `${capture!.relativeDatabasePath}-wal`,
      `${capture!.relativeDatabasePath}-shm`,
      `${capture!.relativeDatabasePath}-journal`,
    ]));
    await discardRtkGainSegment(runtime, capture!);
    expect(runtime.files.has(capture!.relativeDatabasePath)).toBe(false);
  });

  it('discovers persisted valid segments and removes malformed or orphaned entries', async () => {
    const runtime = new MemoryRuntime();
    const segment = await createRtkGainSegment(runtime, { provider: 'openai', id: 'gpt-4o' });
    runtime.files.set('rtk-optimizer/gain/not-a-manifest.db', new Uint8Array([1]));
    runtime.files.set('rtk-optimizer/gain/' + 'a'.repeat(64) + '.db', new Uint8Array([1]));
    expect(await discoverRtkGainSegments(runtime)).toEqual([segment]);
    expect(runtime.files.has('rtk-optimizer/gain/' + 'a'.repeat(64) + '.db')).toBe(false);
    await discardRtkGainSegment(runtime, segment!);
    expect(await discoverRtkGainSegments(runtime)).toEqual([]);
  });

  it('rejects malformed or inconsistent summaries', () => {
    const valid = {
      summary: { total_commands: 1, total_input: 8, total_output: 2, total_saved: 6 },
    };
    expect(parseRtkGainSummary(JSON.stringify(valid))).toEqual({ calls: 1, inputTokens: 8, outputTokens: 2 });
    for (const value of [
      '',
      '{}',
      JSON.stringify({ summary: { ...valid.summary, total_commands: -1 } }),
      JSON.stringify({ summary: { ...valid.summary, total_input: 1.5 } }),
      JSON.stringify({ summary: { ...valid.summary, total_output: Number.MAX_SAFE_INTEGER + 1 } }),
      JSON.stringify({ summary: { ...valid.summary, total_saved: 7 } }),
      JSON.stringify({ summary: { total_commands: 0, total_input: 1, total_output: 1, total_saved: 0 } }),
    ]) expect(parseRtkGainSummary(value)).toBeUndefined();
  });

  it('fails open and cleans up when gain execution fails or is truncated', async () => {
    for (const response of [
      result('', 1, 'unsupported'),
      { ...result('{"summary":', 0), truncated: true },
      { ...result('', 143), killed: true },
    ]) {
      const runtime = new MemoryRuntime(async () => response);
      const capture = await createRtkGainSegment(runtime, undefined, { now: () => NOW });
      runtime.files.set(capture!.relativeDatabasePath, new Uint8Array([1]));

      await expect(readRtkGainSegment(runtime, 'rtk', capture!)).resolves.toBeUndefined();
      expect(runtime.files.has(capture!.relativeDatabasePath)).toBe(true);
    }
  });

  it('prunes stale capture files without touching recent or unrelated entries', async () => {
    const runtime = new MemoryRuntime();
    const oldTimestamp = NOW - 24 * 60 * 60 * 1_000 - 1;
    const recentTimestamp = NOW - 1;
    const old = `rtk-optimizer/gain/${oldTimestamp}-11111111-1111-4111-8111-111111111111.db`;
    const oldSidecar = `${old}-wal`;
    const recent = `rtk-optimizer/gain/${recentTimestamp}-22222222-2222-4222-8222-222222222222.db`;
    const unrelated = 'rtk-optimizer/gain/keep.txt';
    for (const path of [old, oldSidecar, recent, unrelated]) runtime.files.set(path, new Uint8Array([1]));

    await createRtkGainSegment(runtime, undefined, { now: () => NOW });

    expect(runtime.files.has(old)).toBe(false);
    expect(runtime.files.has(oldSidecar)).toBe(false);
    expect(runtime.files.has(recent)).toBe(true);
    expect(runtime.files.has(unrelated)).toBe(true);
  });
});
