import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireLocalFileLock, withLocalFileLock } from '../src/lock.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('local file locks', () => {
  it('contains an asynchronous heartbeat compromise and exposes it to the caller', async () => {
    const root = await temporaryDirectory();
    const target = join(root, 'target');
    await writeFile(target, '');
    const lock = await acquireLocalFileLock(target, {
      realpath: false,
      stale: 2_000,
      update: 1_000,
    });

    await utimes(`${target}.lock`, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
    await waitFor(() => lock.isCompromised());

    expect(lock.compromised.aborted).toBe(true);
    expect(() => lock.throwIfCompromised('lock was lost')).toThrow('lock was lost');
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it('turns a heartbeat compromise into an awaited operation failure', async () => {
    const root = await temporaryDirectory();
    const target = join(root, 'target');
    await writeFile(target, '');

    await expect(withLocalFileLock(target, {
      realpath: false,
      stale: 2_000,
      update: 1_000,
    }, async (lock) => {
      await utimes(`${target}.lock`, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000));
      await waitFor(() => lock.isCompromised());
      return 'unreachable';
    })).rejects.toThrow('Unable to update lock within the stale threshold');
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-lock-'));
  temporaryPaths.push(path);
  return path;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition was not reached before timeout');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
