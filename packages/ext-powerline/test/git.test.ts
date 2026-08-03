import type { FelanExtensionAPI } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import { GitCache, formatAge, parseGitStatus, runGit } from '../src/git.js';

describe('Git status parsing', () => {
  it('parses porcelain v2 branch, upstream, stash, and working tree state', () => {
    expect(parseGitStatus([
      '# branch.oid abcdef',
      '# branch.head story-10',
      '# branch.upstream origin/story-10',
      '# branch.ab +2 -3',
      '# stash 4',
      '1 .M N... 100644 100644 100644 abc abc file.ts',
      '? new.ts',
    ].join('\n'))).toEqual({
      branch: 'story-10',
      changedFiles: 2,
      stashCount: 4,
      upstream: { name: 'origin/story-10', ahead: 2, behind: 3 },
    });
  });

  it('parses detached and legacy porcelain status and handles empty output', () => {
    expect(parseGitStatus('# branch.oid abc\n# branch.head (detached)')).toEqual({
      branch: 'detached', changedFiles: 0, stashCount: 0,
    });
    expect(parseGitStatus('## main...origin/main [ahead 1, behind 2]\n M one\n?? two')).toEqual({
      branch: 'main',
      changedFiles: 2,
      stashCount: 0,
      upstream: { name: 'origin/main', ahead: 1, behind: 2 },
    });
    expect(parseGitStatus(undefined)).toBeUndefined();
  });

  it('formats commit age boundaries', () => {
    const now = 10_000_000_000;
    expect(formatAge(now / 1_000 - 59, now)).toBe('59s');
    expect(formatAge(now / 1_000 - 60 * 30, now)).toBe('30m');
    expect(formatAge(now / 1_000 - 60 * 60 * 3, now)).toBe('3h');
    expect(formatAge(Number.NaN, now)).toBeUndefined();
  });
});

describe('Git execution and cache', () => {
  it('uses pi.exec with a timeout and suppresses exit, kill, and thrown failures', async () => {
    const success = vi.fn().mockResolvedValue({ stdout: ' main \n', stderr: '', code: 0, killed: false });
    await expect(runGit({ exec: success } as never, ['branch', '--show-current'], '/workspace')).resolves.toBe('main');
    expect(success).toHaveBeenCalledWith('git', ['branch', '--show-current'], { cwd: '/workspace', timeout: 1_200 });

    for (const result of [
      { stdout: 'ignored', stderr: 'bad', code: 1, killed: false },
      { stdout: 'ignored', stderr: '', code: 0, killed: true },
    ]) {
      await expect(runGit({ exec: vi.fn().mockResolvedValue(result) } as never, ['status'], '/workspace')).resolves.toBeUndefined();
    }
    await expect(runGit({ exec: vi.fn().mockRejectedValue(new Error('missing git')) } as never, ['status'], '/workspace')).resolves.toBeUndefined();
  });

  it('coalesces refreshes and caches parsed repository details', async () => {
    const exec = vi.fn(async (_command: string, args: string[]) => {
      const key = args.join(' ');
      const stdout = new Map([
        ['rev-parse --show-toplevel', '/workspace/repo'],
        ['rev-parse --short HEAD', 'abc123'],
        ['status --porcelain=v2 --branch --show-stash', '# branch.oid abc123\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +1 -0\n# stash 2\n? new.ts'],
        ['describe --tags --exact-match', 'v1.0.0'],
        ['log -1 --format=%ct', '9990'],
      ]).get(key);
      return { stdout: stdout ?? '', stderr: '', code: 0, killed: false };
    });
    const cache = new GitCache({ exec } as unknown as Pick<FelanExtensionAPI, 'exec'>, '/workspace/repo', () => 10_000_000);

    await Promise.all([cache.refresh(), cache.refresh(), cache.refresh()]);

    expect(exec).toHaveBeenCalledTimes(5);
    expect(cache.get()).toEqual({
      branch: 'main', sha: 'abc123', dirty: true, changedFiles: 1, tag: 'v1.0.0', timeSinceCommit: '10s',
      stashCount: 2, upstream: { name: 'origin/main', ahead: 1, behind: 0 }, repoName: 'repo', refreshedAt: 10_000_000,
    });
  });

  it('retains cached status details when later status probes fail or time out', async () => {
    let statusAttempt = 0;
    const exec = vi.fn(async (_command: string, args: string[]) => {
      const key = args.join(' ');
      if (key === 'status --porcelain=v2 --branch --show-stash') {
        statusAttempt += 1;
        if (statusAttempt === 2) return { stdout: '', stderr: 'failed', code: 1, killed: false };
        if (statusAttempt === 3) return { stdout: '', stderr: '', code: 0, killed: true };
        return {
          stdout: '# branch.oid abc123\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +1 -2\n# stash 3\n? new.ts',
          stderr: '',
          code: 0,
          killed: false,
        };
      }
      const stdout = new Map([
        ['rev-parse --show-toplevel', '/workspace/repo'],
        ['rev-parse --short HEAD', 'abc123'],
      ]).get(key);
      return { stdout: stdout ?? '', stderr: '', code: 0, killed: false };
    });
    let now = 1;
    const cache = new GitCache(
      { exec } as unknown as Pick<FelanExtensionAPI, 'exec'>,
      '/workspace/repo',
      () => now,
    );

    await cache.refresh();
    const expectedStatus = {
      branch: 'main', dirty: true, changedFiles: 1, stashCount: 3,
      upstream: { name: 'origin/main', ahead: 1, behind: 2 },
    };
    expect(cache.get()).toMatchObject(expectedStatus);

    now = 2;
    await cache.refresh();
    expect(cache.get()).toMatchObject({ ...expectedStatus, refreshedAt: 2 });

    now = 3;
    await cache.refresh();
    expect(cache.get()).toMatchObject({ ...expectedStatus, refreshedAt: 3 });
  });

  it('omits status details when the initial status probe is unavailable', async () => {
    const exec = vi.fn(async (_command: string, args: string[]) => {
      const key = args.join(' ');
      if (key === 'status --porcelain=v2 --branch --show-stash') {
        return { stdout: '', stderr: '', code: 0, killed: true };
      }
      const stdout = key === 'rev-parse --show-toplevel' ? '/workspace/repo' : '';
      return { stdout, stderr: '', code: 0, killed: false };
    });
    const cache = new GitCache({ exec } as unknown as Pick<FelanExtensionAPI, 'exec'>, '/workspace/repo', () => 1);

    await cache.refresh();

    expect(cache.get()).toEqual({ repoName: 'repo', refreshedAt: 1 });
  });

  it('clears cached details when the repository probe fails and ignores late results after disposal', async () => {
    let rootAvailable = true;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const exec = vi.fn(async (_command: string, args: string[]) => {
      const key = args.join(' ');
      if (key === 'rev-parse --show-toplevel') {
        if (!rootAvailable) return { stdout: '', stderr: 'not a repo', code: 128, killed: false };
        return { stdout: '/repo', stderr: '', code: 0, killed: false };
      }
      await blocked;
      return { stdout: '', stderr: '', code: 0, killed: false };
    });
    const cache = new GitCache({ exec } as unknown as Pick<FelanExtensionAPI, 'exec'>, '/repo');
    const refresh = cache.refresh();
    cache.dispose();
    release();
    await refresh;
    expect(cache.get()).toBeUndefined();

    const failed = new GitCache({ exec } as unknown as Pick<FelanExtensionAPI, 'exec'>, '/repo');
    rootAvailable = false;
    await expect(failed.refresh()).resolves.toBeUndefined();
    expect(failed.get()).toBeUndefined();
  });
});
