import { describe, expect, it } from 'vitest';
import { computeRewriteDecision, inspectRtkRuntime, isAlreadyRtk, resolveRtkRewrite } from '../src/command-rewriter.js';
import { MemoryRuntime, result } from './test-runtime.js';

describe('RTK rewrite delegation', () => {
  it('delegates the complete command to rtk rewrite', async () => {
    const runtime = new MemoryRuntime(async (command, args) => {
      if (command === 'rtk' && args[0] === 'rewrite') return result('rtk git status\n', 0);
      return result('', 1, 'unexpected');
    });

    await expect(computeRewriteDecision(runtime, 'git status')).resolves.toMatchObject({
      changed: true,
      rewrittenCommand: 'rtk git status',
      reason: 'ok',
    });
    expect(runtime.execCalls[0]).toMatchObject({
      command: 'rtk',
      args: ['rewrite', 'git status'],
      options: { timeout: 3_000 },
    });
  });

  it('does not probe empty or already-RTK commands', async () => {
    const runtime = new MemoryRuntime();
    expect(isAlreadyRtk('CI=1 RTK_DB_PATH=/tmp/db rtk git status')).toBe(true);
    await expect(computeRewriteDecision(runtime, '  ')).resolves.toMatchObject({ reason: 'empty' });
    await expect(computeRewriteDecision(runtime, 'CI=1 rtk git status')).resolves.toMatchObject({
      reason: 'already_rtk',
    });
    expect(runtime.execCalls).toEqual([]);
  });

  it('preserves RTK denial and unexpected-exit diagnostics', async () => {
    const denied = new MemoryRuntime(async () => result('', 2, 'unsafe command'));
    await expect(resolveRtkRewrite(denied, 'rm -rf build')).resolves.toMatchObject({
      changed: false,
      exitCode: 2,
      error: 'unsafe command',
    });

    const unexpected = new MemoryRuntime(async () => result('', 9));
    await expect(resolveRtkRewrite(unexpected, 'git status')).resolves.toMatchObject({
      changed: false,
      error: 'unexpected exit code 9',
    });
  });

  it('checks availability through the same runtime', async () => {
    const available = new MemoryRuntime(async () => result('rtk 1.2.3\n'));
    await expect(inspectRtkRuntime(available)).resolves.toMatchObject({
      rtkAvailable: true,
      version: 'rtk 1.2.3',
    });

    const missing = new MemoryRuntime(async () => result('', 127, 'rtk: not found'));
    await expect(inspectRtkRuntime(missing)).resolves.toMatchObject({
      rtkAvailable: false,
      lastError: 'rtk: not found',
    });
  });
});
