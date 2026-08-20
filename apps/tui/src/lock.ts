import * as nodeFs from 'node:fs';
import { lstat, utimes } from 'node:fs/promises';
import lockfile, { type LockOptions } from 'proper-lockfile';

export type LocalFileLockOptions = Omit<LockOptions, 'onCompromised'> & {
  readonly preservePathOnRelease?: boolean;
};

export interface LocalFileLock {
  readonly compromised: AbortSignal;
  isCompromised(): boolean;
  isCurrent(): Promise<boolean>;
  throwIfCompromised(message?: string): void;
  retire(staleMs: number): Promise<void>;
  release(): Promise<void>;
}

export async function withLocalFileLock<T>(
  path: string,
  options: LocalFileLockOptions,
  operation: (lock: LocalFileLock) => Promise<T>,
): Promise<T> {
  const lock = await acquireLocalFileLock(path, {
    ...options,
    preservePathOnRelease: true,
  });
  try {
    lock.throwIfCompromised();
    const result = await operation(lock);
    lock.throwIfCompromised();
    return result;
  } finally {
    await lock.release();
    await lock.retire(options.stale ?? 10_000);
  }
}

export async function acquireLocalFileLock(
  path: string,
  options: LocalFileLockOptions = {},
): Promise<LocalFileLock> {
  const controller = new AbortController();
  let compromiseError: Error | undefined;
  const lockPath = options.lockfilePath ?? `${path}.lock`;
  const { preservePathOnRelease = false, ...lockOptions } = options;
  const identityRef: { current?: LockIdentity } = {};
  const releaseLock = await lockfile.lock(path, {
    ...lockOptions,
    fs: createGuardedFs(lockPath, identityRef, preservePathOnRelease),
    onCompromised: (error) => {
      compromiseError ??= error;
      controller.abort(error);
    },
  });
  const lockIdentity = await readLockIdentity(lockPath);
  if (!lockIdentity) {
    const error = new Error('Local file lock disappeared during acquisition');
    compromiseError = error;
    controller.abort(error);
    throw error;
  }
  identityRef.current = lockIdentity;
  const isCurrent = async (): Promise<boolean> => {
    if (compromiseError) return false;
    const current = await readLockIdentity(lockPath);
    return current !== undefined && sameLockIdentity(current, lockIdentity);
  };
  let released = false;

  return {
    compromised: controller.signal,
    isCompromised: () => compromiseError !== undefined,
    isCurrent,
    throwIfCompromised(message?: string): void {
      if (!compromiseError) return;
      if (message === undefined) throw compromiseError;
      throw new Error(message, { cause: compromiseError });
    },
    async retire(staleMs: number): Promise<void> {
      if (!preservePathOnRelease || !(await isCurrent())) return;
      const retiredAt = new Date(Date.now() - Math.max(staleMs, 2_000) - 1_000);
      await utimes(lockPath, retiredAt, retiredAt).catch(() => {});
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        await releaseLock();
      } catch (error) {
        if (!compromiseError && await isCurrent()) throw error;
      }
    },
  };
}

interface LockIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
}

type RmdirCallback = (error: NodeJS.ErrnoException | null) => void;

function createGuardedFs(
  lockPath: string,
  identityRef: { current?: LockIdentity },
  preservePathOnRelease: boolean,
): typeof nodeFs {
  const guarded = {
    ...nodeFs,
    rmdir(path: Parameters<typeof nodeFs.rmdir>[0], callback: RmdirCallback): void {
      if (path !== lockPath) {
        nodeFs.rmdir(path, callback);
        return;
      }
      if (!identityRef.current) {
        nodeFs.rmdir(path, (error) => {
          // A populated stale lock is still owned. Let proper-lockfile's
          // follow-up mkdir report ELOCKED instead of surfacing ENOTEMPTY.
          callback(isNotEmpty(error) ? null : error);
        });
        return;
      }
      if (preservePathOnRelease) {
        callback(null);
        return;
      }
      nodeFs.lstat(path, (error, stats) => {
        if (error) {
          if (isMissing(error)) {
            callback(null);
            return;
          }
          callback(error);
          return;
        }
        if (!sameLockIdentity(stats, identityRef.current!)) {
          callback(null);
          return;
        }
        nodeFs.rmdir(path, callback);
      });
    },
    rmdirSync(path: Parameters<typeof nodeFs.rmdirSync>[0]): void {
      if (path !== lockPath) {
        nodeFs.rmdirSync(path);
        return;
      }
      if (!identityRef.current) {
        try {
          nodeFs.rmdirSync(path);
        } catch (error) {
          if (!isNotEmpty(error)) throw error;
        }
        return;
      }
      if (preservePathOnRelease) return;
      let stats: nodeFs.Stats;
      try {
        stats = nodeFs.lstatSync(path);
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
      if (!sameLockIdentity(stats, identityRef.current)) return;
      nodeFs.rmdirSync(path);
    },
  };
  return guarded as typeof nodeFs;
}

async function readLockIdentity(path: string): Promise<LockIdentity | undefined> {
  try {
    const stats = await lstat(path);
    return { dev: stats.dev, ino: stats.ino, birthtimeMs: stats.birthtimeMs };
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function sameLockIdentity(left: Pick<nodeFs.Stats, 'dev' | 'ino' | 'birthtimeMs'>, right: LockIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT';
}

function isNotEmpty(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOTEMPTY';
}
