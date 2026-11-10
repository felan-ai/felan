import { lstat, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireLocalFileLock, withLocalFileLock } from '../src/lock.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('local file locks', () => {
  it('contains an asynchronous heartbeat compromise and exposes it to the caller', async () => {
    const root = await temporaryDirectory();
    const target = join(root, 'target');
    await writeFile(target, '');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const lock = await acquireLocalFileLock(target, {
      realpath: false,
      stale: 2_000,
      update: 1_000,
    });

    await utimes(`${target}.lock`, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    await heartbeatCompromise(lock.compromised);

    expect(lock.compromised.aborted).toBe(true);
    expect(() => lock.throwIfCompromised('lock was lost')).toThrow('lock was lost');
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it('turns a heartbeat compromise into an awaited operation failure', async () => {
    const root = await temporaryDirectory();
    const target = join(root, 'target');
    await writeFile(target, '');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    await expect(withLocalFileLock(target, {
      realpath: false,
      stale: 2_000,
      update: 1_000,
    }, async (lock) => {
      await utimes(`${target}.lock`, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
      await heartbeatCompromise(lock.compromised);
      return 'unreachable';
    })).rejects.toThrow('Unable to update lock within the stale threshold');
  });

  it('fences a heartbeat after a replacement lock is released', async () => {
    const root = await temporaryDirectory();
    const target = join(root, 'target');
    const lockPath = `${target}.lock`;
    await writeFile(target, '');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const first = await acquireLocalFileLock(target, {
      realpath: false,
      stale: 2_000,
      update: 1_000,
      preservePathOnRelease: true,
    });
    const firstMtime = (await lstat(lockPath)).mtime;

    // Keep the old inode allocated so rapid replacement cannot reuse its filesystem identity.
    await rename(lockPath, join(root, 'previous.lock'));
    const replacement = await acquireLocalFileLock(target, {
      realpath: false,
      stale: 2_000,
      update: 1_000,
      preservePathOnRelease: true,
    });
    await replacement.release();
    await utimes(lockPath, firstMtime, firstMtime);

    await heartbeatCompromise(first.compromised);

    expect(await replacement.isCurrent()).toBe(true);
    expect((await lstat(lockPath)).mtime.getTime()).toBe(firstMtime.getTime());
    await expect(first.release()).resolves.toBeUndefined();
  });

});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-lock-'));
  temporaryPaths.push(path);
  return path;
}

async function heartbeatCompromise(signal: AbortSignal): Promise<void> {
  const compromised = new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
  await vi.advanceTimersByTimeAsync(1_000);
  await compromised;
}
