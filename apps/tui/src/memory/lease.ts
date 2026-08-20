import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { acquireLocalFileLock, type LocalFileLock } from '../lock.js';

export interface LocalMemoryLeaseOptions {
  readonly staleMs?: number;
  readonly updateMs?: number;
}

export interface LocalMemoryLease {
  readonly token: string;
  readonly acquiredAt: string;
  readonly compromised: AbortSignal;
  verify(): Promise<boolean>;
  release(): Promise<void>;
}

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_UPDATE_MS = 10_000;

export async function acquireLocalMemoryLease(
  projectDirectory: string,
  options: LocalMemoryLeaseOptions = {},
): Promise<LocalMemoryLease | undefined> {
  const target = join(projectDirectory, 'writer');
  const gateTarget = join(projectDirectory, 'writer.gate');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, '', { flag: 'a', mode: 0o600 });
  await writeFile(gateTarget, '', { flag: 'a', mode: 0o600 });
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;

  let gateLock: LocalFileLock;
  try {
    gateLock = await acquireLocalFileLock(gateTarget, {
      realpath: false,
      stale: staleMs,
      update: options.updateMs ?? DEFAULT_UPDATE_MS,
      retries: 0,
      preservePathOnRelease: true,
    });
  } catch (error) {
    if (isLocked(error)) return undefined;
    throw error;
  }

  let fileLock: LocalFileLock;
  try {
    await recoverStaleLegacyLock(target, staleMs);
    fileLock = await acquireLocalFileLock(target, {
      realpath: false,
      stale: staleMs,
      update: options.updateMs ?? DEFAULT_UPDATE_MS,
      retries: 0,
      preservePathOnRelease: true,
    });
  } catch (error) {
    await gateLock.release().catch(() => {});
    await gateLock.retire(staleMs);
    if (isLocked(error)) return undefined;
    throw error;
  }

  const token = randomUUID();
  const acquiredAt = new Date().toISOString();
  const ownerPath = `${target}.owner.${token}.json`;
  const temporaryOwnerPath = `${ownerPath}.${token}.tmp`;
  const compromiseController = new AbortController();
  const onCompromise = (): void => {
    compromiseController.abort(new Error('Memory writer lease was lost'));
  };
  gateLock.compromised.addEventListener('abort', onCompromise, { once: true });
  fileLock.compromised.addEventListener('abort', onCompromise, { once: true });
  try {
    await writeFile(temporaryOwnerPath, `${JSON.stringify({ token, acquiredAt, pid: process.pid })}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporaryOwnerPath, ownerPath);
    gateLock.throwIfCompromised('Memory writer lease was lost during acquisition');
    fileLock.throwIfCompromised('Memory writer lease was lost during acquisition');
    if (!(await gateLock.isCurrent()) || !(await fileLock.isCurrent())) {
      throw new Error('Memory writer lease was lost during acquisition');
    }
    await garbageCollectOwnerFiles(target, ownerPath);
  } catch (error) {
    await rm(temporaryOwnerPath, { force: true }).catch(() => {});
    await removeOwnerIfToken(ownerPath, token);
    await fileLock.release().catch(() => {});
    await fileLock.retire(staleMs);
    gateLock.compromised.removeEventListener('abort', onCompromise);
    fileLock.compromised.removeEventListener('abort', onCompromise);
    await gateLock.release().catch(() => {});
    await gateLock.retire(staleMs);
    throw error;
  }

  let released = false;
  return {
    token,
    acquiredAt,
    compromised: compromiseController.signal,
    async verify(): Promise<boolean> {
      if (released || fileLock.isCompromised()) return false;
      if (gateLock.isCompromised()) return false;
      if (!(await gateLock.isCurrent()) || !(await fileLock.isCurrent())) return false;
      try {
        const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { token?: unknown };
        return owner.token === token;
      } catch {
        return false;
      }
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      let ownsOwnerRecord = false;
      try {
        const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { token?: unknown };
        ownsOwnerRecord = owner.token === token;
      } catch {
        // A missing owner record is fenced and must not release a possible successor lock.
      }
      if (ownsOwnerRecord) await rm(ownerPath, { force: true }).catch(() => {});
      // LocalFileLock guards the underlying directory identity before rmdir, so
      // releasing a fenced handle stops its heartbeat without removing a successor.
      await fileLock.release().catch(() => {});
      await fileLock.retire(staleMs);
      gateLock.compromised.removeEventListener('abort', onCompromise);
      fileLock.compromised.removeEventListener('abort', onCompromise);
      await gateLock.release().catch(() => {});
      await gateLock.retire(staleMs);
    },
  };
}

async function garbageCollectOwnerFiles(target: string, currentOwnerPath: string): Promise<void> {
  const directory = dirname(target);
  const prefix = `${basename(target)}.owner.`;
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  await Promise.all(entries
    .filter((entry) => entry.startsWith(prefix) && join(directory, entry) !== currentOwnerPath)
    .map((entry) => rm(join(directory, entry), { force: true })));
}

async function recoverStaleLegacyLock(target: string, staleMs: number): Promise<void> {
  const lockPath = `${target}.lock`;
  const ownerPath = join(lockPath, 'owner.json');
  const effectiveStaleMs = Math.max(staleMs, 2_000);
  const initial = await safeLstat(lockPath);
  if (!initial?.isDirectory() || initial.mtimeMs >= Date.now() - effectiveStaleMs) return;
  const owner = await safeLstat(ownerPath);
  if (!owner?.isFile()) return;
  const confirmed = await safeLstat(lockPath);
  if (!confirmed?.isDirectory()
    || confirmed.mtimeMs !== initial.mtimeMs
    || confirmed.mtimeMs >= Date.now() - effectiveStaleMs) return;
  await rm(ownerPath, { force: true });
  const retiredAt = new Date(Date.now() - effectiveStaleMs - 1_000);
  await utimes(lockPath, retiredAt, retiredAt).catch(() => {});
}

async function removeOwnerIfToken(ownerPath: string, token: string): Promise<void> {
  try {
    const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { token?: unknown };
    if (owner.token === token) await rm(ownerPath, { force: true });
  } catch {}
}

async function safeLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function isLocked(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && Reflect.get(error, 'code') === 'ELOCKED';
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT';
}

