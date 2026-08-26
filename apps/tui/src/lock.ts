import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, mkdir, realpath, rename, rmdir, stat, utimes } from 'node:fs/promises';
import { resolve } from 'node:path';

interface LocalFileLockRetryOptions {
  readonly retries?: number;
  readonly factor?: number;
  readonly minTimeout?: number;
  readonly maxTimeout?: number;
  readonly randomize?: boolean;
}

export interface LocalFileLockOptions {
  readonly stale?: number;
  readonly update?: number;
  readonly retries?: number | LocalFileLockRetryOptions;
  readonly realpath?: boolean;
  readonly lockfilePath?: string;
  readonly preservePathOnRelease?: boolean;
}

export interface LocalFileLock {
  readonly compromised: AbortSignal;
  isCompromised(): boolean;
  isCurrent(): Promise<boolean>;
  throwIfCompromised(message?: string): void;
  retire(staleMs: number): Promise<void>;
  release(): Promise<void>;
}

interface LockIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly birthtimeMs: number;
}

interface LockState {
  readonly lockPath: string;
  readonly identity: LockIdentity;
  readonly staleMs: number;
  readonly updateMs: number;
  readonly precision: 'milliseconds' | 'seconds';
  readonly onCompromised: (error: Error) => void;
  status: 'active' | 'compromised' | 'released';
  mtime: Date;
  lastUpdateMs: number;
  updateDelayMs: number | undefined;
  updateTimer: NodeJS.Timeout | undefined;
  heartbeat: Promise<void> | undefined;
}

const DEFAULT_STALE_MS = 10_000;
const MINIMUM_STALE_MS = 2_000;
const MINIMUM_UPDATE_MS = 1_000;

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
    await lock.retire(options.stale ?? DEFAULT_STALE_MS);
  }
}

export async function acquireLocalFileLock(
  path: string,
  options: LocalFileLockOptions = {},
): Promise<LocalFileLock> {
  const controller = new AbortController();
  let compromiseError: Error | undefined;
  const canonicalPath = options.realpath === false ? resolve(path) : await realpath(path);
  const lockPath = options.lockfilePath ?? `${canonicalPath}.lock`;
  const staleMs = Math.max(options.stale ?? DEFAULT_STALE_MS, MINIMUM_STALE_MS);
  const requestedUpdateMs = options.update ?? staleMs / 2;
  const updateMs = Math.max(Math.min(requestedUpdateMs, staleMs / 2), MINIMUM_UPDATE_MS);
  const state = await acquireLockState(canonicalPath, lockPath, staleMs, updateMs, options.retries, (error) => {
    compromiseError ??= error;
    controller.abort(error);
  });
  scheduleHeartbeat(state);
  const isCurrent = async (): Promise<boolean> => {
    if (compromiseError) return false;
    const current = await readLockIdentity(lockPath);
    return current !== undefined && sameLockIdentity(current, state.identity);
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
    async retire(retireStaleMs: number): Promise<void> {
      if (!options.preservePathOnRelease || !(await isCurrent())) return;
      const retiredAt = new Date(Date.now() - Math.max(retireStaleMs, MINIMUM_STALE_MS) - 1_000);
      await setTimes(lockPath, retiredAt).catch(() => {});
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      const owned = state.status === 'active';
      state.status = 'released';
      clearHeartbeat(state);
      await state.heartbeat;
      if (!owned || options.preservePathOnRelease) return;
      await removeLockIfCurrent(lockPath, state.identity);
    },
  };
}

async function acquireLockState(
  targetPath: string,
  lockPath: string,
  staleMs: number,
  updateMs: number,
  retries: LocalFileLockOptions['retries'],
  onCompromised: (error: Error) => void,
): Promise<LockState> {
  const retryDelays = createRetryDelays(retries);
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      await acquireLockDirectory(targetPath, lockPath, staleMs);
      return await initializeLockState(targetPath, lockPath, staleMs, updateMs, onCompromised);
    } catch (error) {
      lastError = error;
      const retryDelay = retryDelays[attempt];
      if (retryDelay === undefined) throw error;
      await delay(retryDelay);
    }
  }
  throw lastError;
}

async function acquireLockDirectory(
  targetPath: string,
  lockPath: string,
  staleMs: number,
): Promise<void> {
  try {
    await mkdir(lockPath);
    return;
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) throw error;
  }

  let stats: Stats;
  try {
    stats = await stat(lockPath);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error;
    return makeDirectoryWithoutStaleRecovery(targetPath, lockPath);
  }
  if (stats.mtime.getTime() >= Date.now() - staleMs) throw lockHeldError(targetPath);

  if (!(await reclaimStaleLock(lockPath, stats))) throw lockHeldError(targetPath);
  await makeDirectoryWithoutStaleRecovery(targetPath, lockPath);
}

async function reclaimStaleLock(lockPath: string, observed: Stats): Promise<boolean> {
  const claimPath = lockClaimPath(lockPath, 'reclaim');
  try {
    await rename(lockPath, claimPath);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return true;
    throw error;
  }

  let claimed: Stats;
  try {
    claimed = await lstat(claimPath);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return true;
    await restoreClaim(claimPath, lockPath);
    throw error;
  }
  if (!sameLockIdentity(claimed, lockIdentity(observed))
    || claimed.mtime.getTime() !== observed.mtime.getTime()) {
    await restoreClaim(claimPath, lockPath);
    return false;
  }

  try {
    await rmdir(claimPath);
    return true;
  } catch (error) {
    await restoreClaim(claimPath, lockPath);
    if (isDirectoryNotEmpty(error)) return false;
    if (hasErrorCode(error, 'ENOENT')) return true;
    throw error;
  }
}

async function makeDirectoryWithoutStaleRecovery(
  targetPath: string,
  lockPath: string,
): Promise<void> {
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) throw lockHeldError(targetPath);
    throw error;
  }
}

async function initializeLockState(
  targetPath: string,
  lockPath: string,
  staleMs: number,
  updateMs: number,
  onCompromised: (error: Error) => void,
): Promise<LockState> {
  let identity: LockIdentity | undefined;
  try {
    let initialStats: Stats;
    try {
      initialStats = await lstat(lockPath);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) throw lockHeldError(targetPath);
      throw error;
    }
    identity = lockIdentity(initialStats);
    const probeTime = new Date(Math.ceil(Date.now() / 1_000) * 1_000 + 5);
    try {
      await setTimes(lockPath, probeTime);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) throw lockHeldError(targetPath);
      throw error;
    }
    let stats: Stats;
    try {
      stats = await stat(lockPath);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) throw lockHeldError(targetPath);
      throw error;
    }
    if (!sameLockIdentity(stats, identity)) throw lockHeldError(targetPath);
    return {
      lockPath,
      identity,
      staleMs,
      updateMs,
      precision: stats.mtime.getTime() % 1_000 === 0 ? 'seconds' : 'milliseconds',
      onCompromised,
      status: 'active',
      mtime: stats.mtime,
      lastUpdateMs: Date.now(),
      updateDelayMs: undefined,
      updateTimer: undefined,
      heartbeat: undefined,
    };
  } catch (error) {
    if (identity) await removeLockIfCurrent(lockPath, identity).catch(() => {});
    throw error;
  }
}

function scheduleHeartbeat(state: LockState): void {
  if (state.status !== 'active' || state.updateTimer) return;
  state.updateTimer = setTimeout(() => {
    state.updateTimer = undefined;
    const heartbeat = updateHeartbeat(state).catch((error: unknown) => {
      if (state.status === 'active') compromiseLock(state, toCompromisedError(error));
    }).finally(() => {
      if (state.heartbeat === heartbeat) state.heartbeat = undefined;
    });
    state.heartbeat = heartbeat;
  }, state.updateDelayMs ?? state.updateMs);
  state.updateTimer.unref();
}

async function updateHeartbeat(state: LockState): Promise<void> {
  if (state.status !== 'active') return;
  let stats: Stats;
  try {
    stats = await stat(state.lockPath);
  } catch (error) {
    if (state.status !== 'active') return;
    if (hasErrorCode(error, 'ENOENT') || heartbeatOverdue(state)) {
      compromiseLock(state, toCompromisedError(error));
    } else {
      state.updateDelayMs = MINIMUM_UPDATE_MS;
      scheduleHeartbeat(state);
    }
    return;
  }

  if (state.status !== 'active') return;
  if (!sameLockIdentity(stats, state.identity) || stats.mtime.getTime() !== state.mtime.getTime()) {
    compromiseLock(state, compromisedError('Unable to update lock within the stale threshold'));
    return;
  }

  const mtime = currentMtime(state.precision);
  try {
    await setTimes(state.lockPath, mtime);
  } catch (error) {
    if (state.status !== 'active') return;
    if (hasErrorCode(error, 'ENOENT') || heartbeatOverdue(state)) {
      compromiseLock(state, toCompromisedError(error));
    } else {
      state.updateDelayMs = MINIMUM_UPDATE_MS;
      scheduleHeartbeat(state);
    }
    return;
  }

  if (state.status !== 'active') return;
  let confirmed: Stats;
  try {
    confirmed = await stat(state.lockPath);
  } catch (error) {
    if (state.status !== 'active') return;
    state.mtime = mtime;
    if (hasErrorCode(error, 'ENOENT') || heartbeatOverdue(state)) {
      compromiseLock(state, toCompromisedError(error));
    } else {
      state.updateDelayMs = MINIMUM_UPDATE_MS;
      scheduleHeartbeat(state);
    }
    return;
  }

  if (state.status !== 'active') return;
  if (!sameLockIdentity(confirmed, state.identity) || confirmed.mtime.getTime() !== mtime.getTime()) {
    compromiseLock(state, compromisedError('Unable to update lock within the stale threshold'));
    return;
  }
  state.mtime = mtime;
  state.lastUpdateMs = Date.now();
  state.updateDelayMs = undefined;
  scheduleHeartbeat(state);
}

function heartbeatOverdue(state: LockState): boolean {
  return state.lastUpdateMs + state.staleMs < Date.now();
}

function compromiseLock(state: LockState, error: Error): void {
  if (state.status !== 'active') return;
  state.status = 'compromised';
  clearHeartbeat(state);
  state.onCompromised(error);
}

function clearHeartbeat(state: LockState): void {
  if (!state.updateTimer) return;
  clearTimeout(state.updateTimer);
  state.updateTimer = undefined;
}

function currentMtime(precision: LockState['precision']): Date {
  const now = Date.now();
  return new Date(precision === 'seconds' ? Math.ceil(now / 1_000) * 1_000 : now);
}

function createRetryDelays(retries: LocalFileLockOptions['retries']): number[] {
  const options = typeof retries === 'number' ? { retries } : retries;
  const count = Math.max(0, Math.floor(options?.retries ?? (options ? 10 : 0)));
  const factor = options?.factor ?? 2;
  const minTimeout = options?.minTimeout ?? 1_000;
  const maxTimeout = options?.maxTimeout ?? Number.POSITIVE_INFINITY;
  if (minTimeout > maxTimeout) throw new Error('minTimeout is greater than maxTimeout');
  return Array.from({ length: count }, (_, attempt) => {
    const random = options?.randomize ? Math.random() + 1 : 1;
    return Math.min(Math.round(random * minTimeout * factor ** attempt), maxTimeout);
  }).sort((left, right) => left - right);
}

function lockHeldError(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error('Lock file is already being held'), { code: 'ELOCKED', file: path });
}

function compromisedError(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code: 'ECOMPROMISED' });
}

function toCompromisedError(error: unknown): Error {
  if (error instanceof Error) return compromisedError(error.message, error);
  return compromisedError('Unable to update lock within the stale threshold', error);
}

async function removeLockIfCurrent(
  lockPath: string,
  identity: LockIdentity,
): Promise<void> {
  const current = await readLockIdentity(lockPath);
  if (!current || !sameLockIdentity(current, identity)) return;
  const claimPath = lockClaimPath(lockPath, 'release');
  try {
    await rename(lockPath, claimPath);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return;
    throw error;
  }
  let claimed: LockIdentity | undefined;
  try {
    claimed = await readLockIdentity(claimPath);
  } catch (error) {
    await restoreClaim(claimPath, lockPath);
    throw error;
  }
  if (!claimed || !sameLockIdentity(claimed, identity)) {
    await restoreClaim(claimPath, lockPath);
    return;
  }
  try {
    await rmdir(claimPath);
  } catch (error) {
    await restoreClaim(claimPath, lockPath);
    if (!hasErrorCode(error, 'ENOENT')) throw error;
  }
}

async function restoreClaim(claimPath: string, lockPath: string): Promise<void> {
  try {
    await lstat(lockPath);
    return;
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) throw error;
  }
  try {
    await rename(claimPath, lockPath);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'EEXIST') || hasErrorCode(error, 'ENOTEMPTY')) return;
    throw error;
  }
}

function lockClaimPath(lockPath: string, operation: 'reclaim' | 'release'): string {
  return `${lockPath}.${operation}-${process.pid}-${randomUUID()}`;
}

async function readLockIdentity(path: string): Promise<LockIdentity | undefined> {
  try {
    return lockIdentity(await lstat(path));
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function lockIdentity(stats: Pick<Stats, 'dev' | 'ino' | 'birthtimeMs'>): LockIdentity {
  return { dev: stats.dev, ino: stats.ino, birthtimeMs: stats.birthtimeMs };
}

function sameLockIdentity(
  left: Pick<Stats, 'dev' | 'ino' | 'birthtimeMs'>,
  right: LockIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code;
}

function isDirectoryNotEmpty(error: unknown): boolean {
  return hasErrorCode(error, 'ENOTEMPTY') || hasErrorCode(error, 'EEXIST');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function setTimes(path: string, time: Date): Promise<void> {
  return utimes(path, time, time);
}
