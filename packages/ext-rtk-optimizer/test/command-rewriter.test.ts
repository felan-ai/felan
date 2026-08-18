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

  it('qualifies rewrites from a managed RTK executable that is not on PATH', async () => {
    const executable = "/agent storage/rtk-optimizer/bin/rtk";
    const runtime = new MemoryRuntime(async (command, args) => {
      if (command === executable && args[0] === 'rewrite') return result('rtk git status && rtk npm test\n', 0);
      return result('', 1, 'unexpected');
    });

    await expect(resolveRtkRewrite(runtime, 'git status', { executable })).resolves.toMatchObject({
      changed: true,
      rewrittenCommand: `(PATH='/agent storage/rtk-optimizer/bin':"$PATH"; export PATH; rtk git status && rtk npm test\n\n)`,
    });
    await expect(computeRewriteDecision(
      runtime,
      `(PATH='/agent storage/rtk-optimizer/bin':"$PATH"; export PATH; rtk git status && rtk npm test\n\n)`,
      { executable },
    )).resolves.toMatchObject({ reason: 'already_rtk' });
    await expect(computeRewriteDecision(runtime, 'rtk gain', { executable })).resolves.toMatchObject({
      changed: true,
      rewrittenCommand: `(PATH='/agent storage/rtk-optimizer/bin':"$PATH"; export PATH; rtk gain\n\n)`,
      reason: 'ok',
    });
    expect(runtime.execCalls).toHaveLength(1);

    const commentRuntime = new MemoryRuntime(async () => result('rtk git status # keep comment\n', 0));
    await expect(resolveRtkRewrite(commentRuntime, 'git status', { executable })).resolves.toMatchObject({
      rewrittenCommand: `(PATH='/agent storage/rtk-optimizer/bin':"$PATH"; export PATH; rtk git status # keep comment\n\n)`,
    });
    const continuationRuntime = new MemoryRuntime(async () => result('rtk git status \\\n', 0));
    await expect(resolveRtkRewrite(continuationRuntime, 'git status', { executable })).resolves.toMatchObject({
      rewrittenCommand: `(PATH='/agent storage/rtk-optimizer/bin':"$PATH"; export PATH; rtk git status \\\n\n)`,
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
    const available = new MemoryRuntime(async (command) => (
      command === 'rtk' ? result('rtk 1.2.3\n') : result('', 127, 'not found')
    ));
    await expect(inspectRtkRuntime(available)).resolves.toMatchObject({
      rtkAvailable: true,
      version: 'rtk 1.2.3',
      source: 'path',
      command: 'rtk',
    });

    const missing = new MemoryRuntime(async () => result('', 127, 'rtk: not found'));
    await expect(inspectRtkRuntime(missing)).resolves.toMatchObject({
      rtkAvailable: false,
      lastError: 'managed: rtk: not found; path: rtk: not found',
    });

    const windows = new MemoryRuntime(async (command) => (
      command === 'rtk' ? result('rtk 1.2.3\n') : result('', 127, 'not found')
    ), 'C:\\agent-storage');
    await expect(inspectRtkRuntime(windows)).resolves.toMatchObject({
      rtkAvailable: true,
      source: 'path',
    });
    expect(windows.execCalls.map((call) => call.command)).toEqual(['rtk']);
  });
});
