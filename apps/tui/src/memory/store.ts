import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  createEmptyMemoryArtifact,
  createMemoryProjectionSnapshot,
  createMemorySnapshot,
  hydrateMemoryDirectory,
  memoryArtifactFingerprint,
  readMemoryDirectory,
  type MemoryArtifact,
  type MemoryFile,
  type MemorySnapshot,
  type SessionCheckpoint,
} from '@felan-ai/ext-memory';
import type { LocalMemoryProject } from './project.js';
import { localMemoryProjectDirectory } from './project.js';
import { acquireLocalMemoryLease, type LocalMemoryLease } from './lease.js';
import { withLocalFileLock } from '../lock.js';

const STATE_VERSION = 1 as const;

export interface StoredCheckpoint {
  readonly checkpoint: SessionCheckpoint;
  readonly recordedAt: string;
}

export interface ProcessedCheckpoint extends StoredCheckpoint {
  readonly processedAt: string;
  readonly memoryFingerprint: string;
}

export interface LocalMemoryState {
  readonly version: typeof STATE_VERSION;
  readonly memoryFingerprint: string;
  readonly pending: Readonly<Record<string, StoredCheckpoint>>;
  readonly processed: Readonly<Record<string, ProcessedCheckpoint>>;
  readonly updatedAt: string;
}

export interface LocalMemoryProcessingSnapshot {
  readonly artifact: MemoryArtifact;
  readonly fingerprint: string;
  readonly checkpoints: readonly StoredCheckpoint[];
  readonly state: LocalMemoryState;
}

export interface LocalMemoryStoreOptions {
  readonly memoryPath?: string;
}

export class LocalMemoryStore {
  readonly projectDirectory: string;
  readonly currentDirectory: string;
  readonly stagingDirectory: string;
  readonly statePath: string;
  readonly projectionName = '.memory';
  readonly #memoryPath: string;

  constructor(
    readonly agentDir: string,
    readonly project: LocalMemoryProject,
    options: LocalMemoryStoreOptions = {},
  ) {
    this.projectDirectory = localMemoryProjectDirectory(agentDir, project);
    this.currentDirectory = join(this.projectDirectory, 'current');
    this.stagingDirectory = join(this.projectDirectory, 'staging');
    this.statePath = join(this.projectDirectory, 'state.json');
    this.#memoryPath = options.memoryPath ?? '.memory';
  }

  async initialize(): Promise<void> {
    await mkdir(this.projectDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.stagingDirectory, { recursive: true, mode: 0o700 });
    const recoveryLease = await acquireLocalMemoryLease(this.projectDirectory);
    try {
      await withStateLock(this, async () => {
        if (recoveryLease) await recoverTransaction(this);
        const current = await safeLstat(this.currentDirectory);
        if (current?.isSymbolicLink()) throw new Error('Canonical memory current directory cannot be a symlink');
        if (!current) {
          await hydrateMemoryDirectory(createEmptyMemoryArtifact(this.#memoryPath), this.currentDirectory);
        }
        const artifact = await readMemoryDirectory(this.currentDirectory, { memoryPath: this.#memoryPath });
        const fingerprint = memoryArtifactFingerprint(artifact);
        const existing = await readState(this.statePath);
        if (!existing || existing.memoryFingerprint !== fingerprint) {
          await writeState(this.statePath, {
            version: STATE_VERSION,
            memoryFingerprint: fingerprint,
            pending: existing?.pending ?? {},
            processed: existing?.processed ?? {},
            updatedAt: new Date().toISOString(),
          });
        }
      });
    } finally {
      await recoveryLease?.release();
    }
  }

  async readCurrent(): Promise<MemorySnapshot> {
    return withStateLock(this, async () => {
      const artifact = await readMemoryDirectory(this.currentDirectory, { memoryPath: this.#memoryPath });
      return createMemorySnapshot(artifact, this.#memoryPath);
    });
  }

  async projectTo(
    sessionStorageRoot: string,
    snapshot?: MemorySnapshot,
  ): Promise<MemorySnapshot> {
    const current = snapshot ?? await this.readCurrent();
    const target = join(sessionStorageRoot, this.projectionName);
    const projection = createMemoryProjectionSnapshot(current, target);
    await hydrateMemoryDirectory(projection, target, { replace: true, memoryPath: target });
    return projection;
  }

  async recordCheckpoint(checkpoint: SessionCheckpoint): Promise<boolean> {
    return withStateLock(this, async () => {
      const state = await this.readState();
      const previousPending = state.pending[checkpoint.sessionId];
      const previousProcessed = state.processed[checkpoint.sessionId];
      if (sameCursor(previousPending?.checkpoint, checkpoint) || sameCursor(previousProcessed?.checkpoint, checkpoint)) {
        return false;
      }
      const pending = {
        ...state.pending,
        [checkpoint.sessionId]: {
          checkpoint,
          recordedAt: new Date().toISOString(),
        },
      };
      await writeState(this.statePath, { ...state, pending, updatedAt: new Date().toISOString() });
      return true;
    });
  }

  async status(): Promise<LocalMemoryState> {
    return this.readState();
  }

  async processingSnapshot(maxSessions = 8): Promise<LocalMemoryProcessingSnapshot> {
    return withStateLock(this, async () => {
      const state = await this.readState();
      const artifact = await readMemoryDirectory(this.currentDirectory, { memoryPath: this.#memoryPath });
      const fingerprint = memoryArtifactFingerprint(artifact);
      const checkpoints = Object.values(state.pending)
        .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt))
        .slice(0, maxSessions);
      return { artifact, fingerprint, checkpoints, state };
    });
  }

  async createStagingDirectory(): Promise<string> {
    await mkdir(this.stagingDirectory, { recursive: true, mode: 0o700 });
    const path = join(this.stagingDirectory, `run-${randomUUID()}`);
    await mkdir(path, { recursive: true, mode: 0o700 });
    return path;
  }

  async commit(
    lease: LocalMemoryLease,
    baseFingerprint: string,
    artifact: MemoryArtifact,
    processed: readonly StoredCheckpoint[],
  ): Promise<string> {
    if (!(await lease.verify())) throw new Error('Memory writer lease was lost before commit');
    const fingerprint = memoryArtifactFingerprint(artifact);
    const staging = await this.createStagingDirectory();
    const stagedMemory = join(staging, 'memory');
    const previousMemory = join(staging, 'previous');
    const journalPath = join(staging, 'commit.json');
    await hydrateMemoryDirectory(artifact, stagedMemory, { memoryPath: this.#memoryPath });
    await writeFile(journalPath, `${JSON.stringify({
      version: 1,
      baseFingerprint,
      fingerprint,
      processed: processed.map(({ checkpoint }) => checkpoint.sessionId),
    })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (!(await lease.verify())) throw new Error('Memory writer lease was lost before replacement');

    try {
      await withStateLock(this, async () => {
        const current = await readMemoryDirectory(this.currentDirectory, { memoryPath: this.#memoryPath });
        if (memoryArtifactFingerprint(current) !== baseFingerprint) {
          throw new Error('Memory changed while the dream was running');
        }
        if (!(await lease.verify())) throw new Error('Memory writer lease was lost before replacement');
        await rename(this.currentDirectory, previousMemory);
        try {
          await rename(stagedMemory, this.currentDirectory);
          if (!(await lease.verify())) throw new Error('Memory writer lease was lost after replacement');
          const state = await this.readState();
          if (!(await lease.verify())) throw new Error('Memory writer lease was lost before state commit');
          if (state.memoryFingerprint !== baseFingerprint) throw new Error('Memory state changed while the dream was running');
          const processedAt = new Date().toISOString();
          const pending = { ...state.pending };
          const nextProcessed = { ...state.processed };
          for (const entry of processed) {
            const currentPending = pending[entry.checkpoint.sessionId];
            if (!currentPending || !sameCursor(currentPending.checkpoint, entry.checkpoint)) continue;
            delete pending[entry.checkpoint.sessionId];
            nextProcessed[entry.checkpoint.sessionId] = {
              ...entry,
              processedAt,
              memoryFingerprint: fingerprint,
            };
          }
          await writeState(this.statePath, {
            version: STATE_VERSION,
            memoryFingerprint: fingerprint,
            pending,
            processed: nextProcessed,
            updatedAt: processedAt,
          });
        } catch (error) {
          const replacement = await safeLstat(this.currentDirectory);
          if (replacement) await rm(this.currentDirectory, { recursive: true, force: true });
          await rename(previousMemory, this.currentDirectory).catch(() => {});
          throw error;
        }
      });
    } catch (error) {
      throw error;
    }
    await rm(previousMemory, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
    return fingerprint;
  }

  async clearStaging(): Promise<void> {
    await rm(this.stagingDirectory, { recursive: true, force: true });
    await mkdir(this.stagingDirectory, { recursive: true, mode: 0o700 });
  }

  get memoryPath(): string {
    return this.#memoryPath;
  }

  private async readState(): Promise<LocalMemoryState> {
    const state = await readState(this.statePath);
    if (!state) throw new Error('Local memory state is missing or invalid');
    return state;
  }
}

async function recoverTransaction(store: LocalMemoryStore): Promise<void> {
  const entries = await safeReadDir(store.stagingDirectory);
  for (const entry of entries) {
    const path = join(store.stagingDirectory, entry);
    const journalPath = join(path, 'commit.json');
    const journal = await readJson(journalPath);
    if (!journal) {
      await rm(path, { recursive: true, force: true });
      continue;
    }
    const current = await safeLstat(store.currentDirectory);
    const memory = join(path, 'memory');
    const previous = join(path, 'previous');
    if (current && typeof journal.fingerprint === 'string'
      && await fingerprintAt(store.currentDirectory, store.memoryPath) === journal.fingerprint) {
      await applyRecoveredStateUnlocked(store, journal.fingerprint, journal.processed);
      await rm(path, { recursive: true, force: true });
      continue;
    }
    if (!current && await safeLstat(previous)) {
      await rename(previous, store.currentDirectory);
    }
    await rm(path, { recursive: true, force: true });
    void memory;
  }
}

async function applyRecoveredStateUnlocked(store: LocalMemoryStore, fingerprint: string, sessionIds: unknown): Promise<void> {
  if (!Array.isArray(sessionIds)) return;
  const state = await readState(store.statePath);
  if (!state) return;
  const pending = { ...state.pending };
  const processed = { ...state.processed };
  const processedAt = new Date().toISOString();
  for (const sessionId of sessionIds) {
    if (typeof sessionId !== 'string') continue;
    const entry = pending[sessionId];
    if (!entry) continue;
    delete pending[sessionId];
    processed[sessionId] = { ...entry, processedAt, memoryFingerprint: fingerprint };
  }
  await writeState(store.statePath, { ...state, memoryFingerprint: fingerprint, pending, processed, updatedAt: processedAt });
}

async function withStateLock<T>(store: LocalMemoryStore, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(store.statePath), { recursive: true });
  try {
    await writeFile(store.statePath, '{}', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  return withLocalFileLock(store.statePath, {
    realpath: false,
    retries: { retries: 20, minTimeout: 10, maxTimeout: 100 },
  }, operationWithLock(operation));
}

function operationWithLock<T>(operation: () => Promise<T>): (lock: { throwIfCompromised(): void }) => Promise<T> {
  return async (lock) => {
    const result = await operation();
    lock.throwIfCompromised();
    return result;
  };
}

async function writeState(path: string, state: LocalMemoryState): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}

async function readState(path: string): Promise<LocalMemoryState | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!isRecord(value) || value.version !== STATE_VERSION || typeof value.memoryFingerprint !== 'string'
      || !isRecord(value.pending) || !isRecord(value.processed) || typeof value.updatedAt !== 'string') return undefined;
    return {
      version: STATE_VERSION,
      memoryFingerprint: value.memoryFingerprint,
      pending: value.pending as Record<string, StoredCheckpoint>,
      processed: value.processed as Record<string, ProcessedCheckpoint>,
      updatedAt: value.updatedAt,
    };
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function fingerprintAt(path: string, memoryPath: string): Promise<string | undefined> {
  try {
    return memoryArtifactFingerprint(await readMemoryDirectory(path, { memoryPath }));
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return isRecord(value) ? value : undefined;
  } catch (error) {
    if (isMissing(error)) return undefined;
    return undefined;
  }
}

async function safeReadDir(path: string): Promise<string[]> {
  try {
    const { readdir } = await import('node:fs/promises');
    return await readdir(path);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function safeLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function sameCursor(left: SessionCheckpoint | undefined, right: SessionCheckpoint): boolean {
  return left?.leafId === right.leafId && left?.transcriptDigest === right.transcriptDigest;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'EEXIST';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
