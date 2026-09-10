import { describe, expect, it } from 'vitest';
import {
  inspectIndexFailure,
  RecoveryRecords,
  recoveryCompletionPath,
  recoveryRecordPath,
} from '../src/recovery.js';
import { MemoryRuntime } from './test-runtime.js';

describe('Codebase Memory recovery contract', () => {
  it('recognizes only the bounded fatal coordination worker-log signatures', async () => {
    const root = '/agent-storage/codebase-memory/cache';
    const fatalPath = `${root}/logs/.worker-log-Ab12`;
    const ordinaryPath = `${root}/logs/.worker-log-ordinary`;

    await expect(inspectIndexFailure(
      new Error(`index worker ended with exit_nonzero (exit=1, signal=0); inspect log: ${fatalPath}`),
      root,
      async () => new TextEncoder().encode('CBM index worker could not start: active daemon coordination could not be verified safely\n'),
    )).resolves.toEqual({ path: 'logs/.worker-log-Ab12' });

    await expect(inspectIndexFailure(
      new Error(`index worker ended with exit_nonzero (exit=1, signal=0); inspect log: ${ordinaryPath}`),
      root,
      async () => new TextEncoder().encode('index failed because the repository is unreadable\n'),
    )).resolves.toBeUndefined();
  });

  it('rejects paths outside the expected cache log directory', async () => {
    await expect(inspectIndexFailure(
      new Error('index worker ended with exit_nonzero; inspect log: /tmp/other/.worker-log-x'),
      '/agent-storage/codebase-memory/cache',
      async () => new Uint8Array(),
    )).resolves.toBeUndefined();
  });

  it('uses unique active records and immutable completion records', () => {
    const first = recoveryRecordPath('first');
    const second = recoveryRecordPath('second');
    expect(first).not.toBe(second);
    expect(first).toMatch(/^codebase-memory\/recovery\/active-/u);
    expect(recoveryCompletionPath('first')).toBe('codebase-memory/recovery/done-first.json');
  });

  it('expires active records and preserves successful completion records', async () => {
    let now = 100;
    const runtime = new MemoryRuntime();
    const records = new RecoveryRecords(runtime, () => now);
    const record = await records.begin(10);
    expect((await records.active()).map(({ id }) => id)).toEqual([record.id]);
    await records.complete(record, true, 1_000);
    expect(await records.active()).toEqual([]);
    expect(await records.successfulSince(100)).toBe(true);
    now = 2_000;
    expect(await records.successfulSince(100)).toBe(false);
  });
});
