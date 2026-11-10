import { createRequire } from 'node:module';
import { lstat, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installPiAsyncFileLockGuard } from '../src/providers/pi-lock.js';

interface PiLockfileModule {
  lock(path: string, options: {
    realpath: boolean;
    stale: number;
    update: number;
    onCompromised(error: Error): void;
  }): Promise<() => Promise<void>>;
}

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Pi async file lock guard', () => {
  it('fences the released replacement generation that crashes proper-lockfile', async () => {
    installPiAsyncFileLockGuard();
    const piRequire = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
    const lockfile = piRequire('proper-lockfile') as PiLockfileModule;
    const root = await temporaryDirectory();
    const target = join(root, 'target');
    const lockPath = `${target}.lock`;
    await writeFile(target, '');
    let compromised!: (error: Error) => void;
    const compromise = new Promise<Error>(resolve => { compromised = resolve; });
    const options = {
      realpath: false,
      stale: 2_000,
      update: 1_000,
      onCompromised: compromised,
    };
    const releaseFirst = await lockfile.lock(target, options);
    const firstMtime = (await lstat(lockPath)).mtime;

    await rm(lockPath, { recursive: true, force: true });
    const releaseReplacement = await lockfile.lock(target, options);
    await releaseReplacement();
    await mkdir(lockPath);
    await utimes(lockPath, firstMtime, firstMtime);

    expect(await compromise).toHaveProperty('code', 'ECOMPROMISED');
    await expect(releaseFirst()).resolves.toBeUndefined();
  }, 5_000);
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-pi-lock-'));
  temporaryPaths.push(path);
  return path;
}
