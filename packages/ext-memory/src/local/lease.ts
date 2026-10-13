import { removeIfPresent } from './context.js';
import { acquireLocalFileLock } from './lock.js';
import type { MemoryContext } from './context.js';
import { randomUUID } from 'node:crypto';

import { basename, dirname, join } from 'node:path';
import type { LocalFileLock } from './lock.js';


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


export async function acquireLocalMemoryLease(environment: MemoryContext, projectDirectory: string,
  options: LocalMemoryLeaseOptions = {},
): Promise<LocalMemoryLease | undefined> {
  const target = join(projectDirectory, 'writer');
  const gateTarget = join(projectDirectory, 'writer.gate');
  await environment.runtime.files!.ensurePrivateDirectory(dirname(target), { recursive: true });
  await environment.runtime.files!.append(target, new TextEncoder().encode(''));
  await environment.runtime.files!.append(gateTarget, new TextEncoder().encode(''));
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;

  let gateLock: LocalFileLock;
  try {
    gateLock = await acquireLocalFileLock(environment, gateTarget, {
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
    await recoverStaleLegacyLock(environment, target, staleMs);
    fileLock = await acquireLocalFileLock(environment, target, {
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
    await environment.runtime.writeFile(temporaryOwnerPath, new TextEncoder().encode(`${JSON.stringify({ token, acquiredAt, pid: process.pid })}\n`), { noFollow: true, exclusive: true });
    await environment.runtime.files!.move(temporaryOwnerPath, ownerPath);
    gateLock.throwIfCompromised('Memory writer lease was lost during acquisition');
    fileLock.throwIfCompromised('Memory writer lease was lost during acquisition');
    if (!(await gateLock.isCurrent()) || !(await fileLock.isCurrent())) {
      throw new Error('Memory writer lease was lost during acquisition');
    }
    await garbageCollectOwnerFiles(environment, target, ownerPath);
  } catch (error) {
    await removeIfPresent(environment, temporaryOwnerPath).catch(() => {});
    await removeOwnerIfToken(environment, ownerPath, token);
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
        const owner = JSON.parse(new TextDecoder().decode(await environment.runtime.readFile(ownerPath))) as { token?: unknown };
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
        const owner = JSON.parse(new TextDecoder().decode(await environment.runtime.readFile(ownerPath))) as { token?: unknown };
        ownsOwnerRecord = owner.token === token;
      } catch {
        // A missing owner record is fenced and must not release a possible successor lock.
      }
      if (ownsOwnerRecord) await removeIfPresent(environment, ownerPath).catch(() => {});
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


async function garbageCollectOwnerFiles(environment: MemoryContext, target: string, currentOwnerPath: string): Promise<void> {
  const directory = dirname(target);
  const prefix = `${basename(target)}.owner.`;
  let entries: string[];
  try {
    entries = await environment.runtime.listFiles(directory, { includeDirectories: true, includeOther: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  await Promise.all(entries
    .filter((entry) => entry.startsWith(prefix) && join(directory, entry) !== currentOwnerPath)
    .map((entry) => removeIfPresent(environment, join(directory, entry))));
}


async function recoverStaleLegacyLock(environment: MemoryContext, target: string, staleMs: number): Promise<void> {
  const lockPath = `${target}.lock`;
  const ownerPath = join(lockPath, 'owner.json');
  const effectiveStaleMs = Math.max(staleMs, 2_000);
  const initial = await safeLstat(environment, lockPath);
  if (initial?.kind !== 'directory' || initial.modifiedAt >= Date.now() - effectiveStaleMs) return;
  const owner = await safeLstat(environment, ownerPath);
  if (owner?.kind !== 'file') return;
  const confirmed = await safeLstat(environment, lockPath);
  if (confirmed?.kind !== 'directory'
    || confirmed.modifiedAt !== initial.modifiedAt
    || confirmed.modifiedAt >= Date.now() - effectiveStaleMs) return;
  await removeIfPresent(environment, ownerPath);
  const retiredAt = new Date(Date.now() - effectiveStaleMs - 1_000);
  await environment.runtime.files!.touch(lockPath, (retiredAt).getTime()).catch(() => {});
}


async function removeOwnerIfToken(environment: MemoryContext, ownerPath: string, token: string): Promise<void> {
  try {
    const owner = JSON.parse(new TextDecoder().decode(await environment.runtime.readFile(ownerPath))) as { token?: unknown };
    if (owner.token === token) await removeIfPresent(environment, ownerPath);
  } catch {}
}


async function safeLstat(environment: MemoryContext, path: string): Promise<Awaited<Promise<import('@felan-ai/agent-core').RuntimeFileInfo>> | undefined> {
  try {
    return await environment.runtime.files!.inspect(path);
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

