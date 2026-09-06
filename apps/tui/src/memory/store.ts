import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  createEmptyMemoryArtifact,
  createMemoryProjectionSnapshot,
  createMemorySnapshot,
  hydrateMemoryDirectory,
  memoryArtifactFingerprint,
  readMemoryDirectory,
  type MemoryArtifact,
  type MemorySnapshot,
  type SessionCheckpoint,
} from '@felan-ai/ext-memory';
import type { LocalMemoryProject } from './project.js';
import { localMemoryProjectDirectory } from './project.js';
import { acquireLocalMemoryLease, type LocalMemoryLease } from './lease.js';
import { withLocalFileLock } from '../lock.js';

const STATE_VERSION = 1 as const;
const MAX_CONTROL_BYTES = 64 * 1_024;
export const MEMORY_ATTEMPT_TIMEOUT_MS = 60 * 60 * 1_000;
export const MEMORY_RETRY_DELAYS_MS = [60_000, 300_000] as const;

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

export interface LocalMemoryAttemptIdentity {
  readonly runId: string;
  readonly generation: number;
}

export interface LocalMemoryAttempt extends LocalMemoryAttemptIdentity {
  readonly leaseToken: string;
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly baseFingerprint: string;
  readonly checkpoints: readonly StoredCheckpoint[];
  readonly published?: { readonly fingerprint: string; readonly at: string };
}

export interface BeginLocalMemoryAttempt {
  readonly runId: string;
  readonly baseFingerprint: string;
  readonly checkpoints: readonly StoredCheckpoint[];
  readonly deadlineAt?: string;
}

export type LocalMemoryAttemptOutcome =
  | { readonly status: 'success' }
  | { readonly status: 'failure'; readonly reason: string }
  | { readonly status: 'cancelled'; readonly reason?: string };

export interface LocalMemoryControl {
  readonly version: 1;
  readonly generation: number;
  readonly consecutiveFailures: number;
  readonly nextRetryAt?: string;
  readonly autoDisabled?: { readonly reason: string; readonly runId: string; readonly at: string };
  readonly lastDisabledRunId?: string;
  readonly activeAttempt?: LocalMemoryAttempt;
  readonly lastOutcome?: LocalMemoryAttemptIdentity & {
    readonly status: LocalMemoryAttemptOutcome['status'];
    readonly at: string;
  };
  readonly updatedAt: string;
}

export class LocalMemoryControlError extends Error {
  constructor(path: string) {
    super(`Local memory control is malformed or unsupported; processing is blocked: ${path}`);
    this.name = 'LocalMemoryControlError';
  }
}

export interface LocalMemoryStoreOptions {
  readonly memoryPath?: string;
  readonly retryDelaysMs?: readonly [number, number];
}

export class LocalMemoryStore {
  readonly projectDirectory: string;
  readonly currentDirectory: string;
  readonly stagingDirectory: string;
  readonly statePath: string;
  readonly controlPath: string;
  readonly projectionName = '.memory';
  readonly #memoryPath: string;
  readonly #retryDelaysMs: readonly [number, number];

  constructor(
    readonly agentDir: string,
    readonly project: LocalMemoryProject,
    options: LocalMemoryStoreOptions = {},
  ) {
    this.projectDirectory = localMemoryProjectDirectory(agentDir, project);
    this.currentDirectory = join(this.projectDirectory, 'current');
    this.stagingDirectory = join(this.projectDirectory, 'staging');
    this.statePath = join(this.projectDirectory, 'state.json');
    this.controlPath = join(this.projectDirectory, 'control.json');
    this.#memoryPath = options.memoryPath ?? '.memory';
    this.#retryDelaysMs = options.retryDelaysMs ?? MEMORY_RETRY_DELAYS_MS;
    if (this.#retryDelaysMs.length !== 2 || this.#retryDelaysMs.some((delay) => !Number.isFinite(delay) || delay < 0)) {
      throw new Error('Memory retry delays must be two non-negative finite durations');
    }
  }

  async initialize(now = Date.now()): Promise<void> {
    await mkdir(this.projectDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.stagingDirectory, { recursive: true, mode: 0o700 });
    const recoveryLease = await acquireLocalMemoryLease(this.projectDirectory);
    try {
      await withStateLock(this, async () => {
        if (!(await readControl(this.controlPath))) await writeControl(this.controlPath, emptyControl(now));
        if (recoveryLease) await recoverTransaction(this, recoveryLease, now);
        const current = await safeLstat(this.currentDirectory);
        if (current?.isSymbolicLink()) throw new Error('Canonical memory current directory cannot be a symlink');
        if (!current) {
          await verifyInitializationLease(recoveryLease);
          await hydrateMemoryDirectory(createEmptyMemoryArtifact(this.#memoryPath), this.currentDirectory);
        }
        const artifact = await readMemoryDirectory(this.currentDirectory, { memoryPath: this.#memoryPath, mode: 'read' });
        const fingerprint = memoryArtifactFingerprint(artifact);
        const existing = await readState(this.statePath);
        if (!existing || existing.memoryFingerprint !== fingerprint) {
          await verifyInitializationLease(recoveryLease);
          await writeState(this.statePath, {
            version: STATE_VERSION,
            memoryFingerprint: fingerprint,
            pending: existing?.pending ?? {},
            processed: existing?.processed ?? {},
            updatedAt: new Date(now).toISOString(),
          });
        }
      });
    } finally {
      await recoveryLease?.release();
    }
  }

  async readCurrent(): Promise<MemorySnapshot> {
    return withStateLock(this, async () => {
      const artifact = await readMemoryDirectory(this.currentDirectory, { memoryPath: this.#memoryPath, mode: 'read' });
      return createMemorySnapshot(artifact, this.#memoryPath, { mode: 'read' });
    });
  }

  async projectTo(
    sessionStorageRoot: string,
    snapshot?: MemorySnapshot,
  ): Promise<MemorySnapshot> {
    const current = snapshot ?? await this.readCurrent();
    const target = join(sessionStorageRoot, this.projectionName);
    const projection = createMemoryProjectionSnapshot(current, target);
    await hydrateMemoryDirectory(projection, target, { replace: true, memoryPath: target, mode: 'read' });
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

  async readControl(): Promise<LocalMemoryControl> {
    return await readControl(this.controlPath) ?? emptyControl(Date.now());
  }

  async beginAttempt(
    lease: LocalMemoryLease,
    input: BeginLocalMemoryAttempt,
    now = Date.now(),
  ): Promise<LocalMemoryAttempt | undefined> {
    return withStateLock(this, async () => {
      await verifyLease(lease);
      const control = await this.readControl();
      if (control.autoDisabled || control.activeAttempt
        || (control.nextRetryAt && Date.parse(control.nextRetryAt) > now) || input.checkpoints.length === 0) return undefined;
      const attempt: LocalMemoryAttempt = {
        runId: input.runId,
        generation: control.generation,
        leaseToken: lease.token,
        startedAt: new Date(now).toISOString(),
        deadlineAt: input.deadlineAt ?? new Date(now + MEMORY_ATTEMPT_TIMEOUT_MS).toISOString(),
        baseFingerprint: input.baseFingerprint,
        checkpoints: structuredClone(input.checkpoints),
      };
      if (!isMemoryAttempt(attempt)) throw new Error('Invalid memory attempt');
      const state = await this.readState();
      if (state.memoryFingerprint !== input.baseFingerprint
        || await fingerprintAt(this.currentDirectory, this.memoryPath) !== input.baseFingerprint) {
        throw new Error('Memory changed before the attempt started');
      }
      if (input.checkpoints.some((entry) => !sameStoredCheckpoint(state.pending[entry.checkpoint.sessionId], entry))) {
        return undefined;
      }
      await verifyLease(lease);
      await writeControl(this.controlPath, { ...control, activeAttempt: attempt, updatedAt: attempt.startedAt });
      return attempt;
    });
  }

  async finishAttempt(
    lease: LocalMemoryLease | undefined,
    attempt: LocalMemoryAttemptIdentity,
    outcome: LocalMemoryAttemptOutcome,
    now = Date.now(),
  ): Promise<LocalMemoryControl> {
    return withStateLock(this, async () => {
      if (outcome.status !== 'cancelled') {
        await verifyLease(lease);
        await recoverTransaction(this, lease!, now);
      }
      const control = await withPublicationEvidence(this, await this.readControl());
      if (!sameAttempt(control.activeAttempt, attempt)) return control;
      if (outcome.status !== 'cancelled' && control.activeAttempt!.leaseToken !== lease!.token) {
        throw new Error('Memory attempt belongs to a different writer lease');
      }
      if (outcome.status === 'success' && !control.activeAttempt!.published) {
        throw new Error('Memory attempt has not published successfully');
      }
      const next = finishControl(control, outcome, now, this.#retryDelaysMs);
      if (outcome.status !== 'cancelled') await verifyLease(lease);
      await writeControl(this.controlPath, next);
      return next;
    });
  }

  async resetProjectControl(
    now = Date.now(),
    isLocallyEligible: () => boolean = () => true,
  ): Promise<LocalMemoryControl> {
    return withStateLock(this, async () => {
      const control = await withPublicationEvidence(this, await this.readControl());
      const finished = finishControl(control, { status: 'cancelled' }, now, this.#retryDelaysMs);
      const lastDisabledRunId = control.lastDisabledRunId ?? control.autoDisabled?.runId;
      const next: LocalMemoryControl = {
        ...emptyControl(now),
        generation: control.generation + 1,
        ...(finished.lastOutcome ? { lastOutcome: finished.lastOutcome } : {}),
        ...(lastDisabledRunId ? { lastDisabledRunId } : {}),
      };
      if (!isLocallyEligible()) throw new Error('Memory retry was cancelled');
      await writeControl(this.controlPath, next);
      if (!isLocallyEligible()) {
        await writeControl(this.controlPath, control);
        throw new Error('Memory retry was cancelled');
      }
      return next;
    });
  }

  async cancelActiveAttempt(now = Date.now()): Promise<LocalMemoryControl> {
    return withStateLock(this, async () => {
      const control = await withPublicationEvidence(this, await this.readControl());
      if (!control.activeAttempt) return control;
      const next = finishControl(control, { status: 'cancelled' }, now, this.#retryDelaysMs);
      await writeControl(this.controlPath, next);
      return next;
    });
  }

  async reconcileAbandonedAttempt(lease: LocalMemoryLease, now = Date.now()): Promise<LocalMemoryControl> {
    return withStateLock(this, async () => {
      await verifyLease(lease);
      await recoverTransaction(this, lease, now);
      const control = await withPublicationEvidence(this, await this.readControl());
      const active = control.activeAttempt;
      if (!active || (active.leaseToken === lease.token && !active.published && Date.parse(active.deadlineAt) > now)) {
        return control;
      }
      const next = finishControl(control, { status: 'cancelled', reason: 'Memory writer was interrupted' }, now, this.#retryDelaysMs);
      await verifyLease(lease);
      await writeControl(this.controlPath, next);
      return next;
    });
  }

  async processingSnapshot(
    maxSessions = 8,
    include: (checkpoint: SessionCheckpoint) => boolean = () => true,
  ): Promise<LocalMemoryProcessingSnapshot> {
    return withStateLock(this, async () => {
      const state = await this.readState();
      const artifact = await readMemoryDirectory(this.currentDirectory, { memoryPath: this.#memoryPath, mode: 'read' });
      const fingerprint = memoryArtifactFingerprint(artifact);
      const checkpoints = Object.values(state.pending)
        .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt))
        .filter(({ checkpoint }) => include(checkpoint))
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
    attempt?: LocalMemoryAttemptIdentity,
  ): Promise<string> {
    if (!(await lease.verify())) throw new Error('Memory writer lease was lost before commit');
    const fingerprint = memoryArtifactFingerprint(artifact);
    const staging = await this.createStagingDirectory();
    const stagedMemory = join(staging, 'memory');
    const previousMemory = join(staging, 'previous');
    const journalPath = join(staging, 'commit.json');
    await hydrateMemoryDirectory(artifact, stagedMemory, { memoryPath: this.#memoryPath });
    const journal: CommitJournal = {
      version: 2,
      phase: 'prepared',
      baseFingerprint,
      fingerprint,
      checkpoints: structuredClone(processed),
      ...(attempt ? { attempt: { ...attempt, leaseToken: lease.token } } : {}),
    };
    await withStateLock(this, async () => {
      const control = await this.readControl();
      assertPublicationAllowed(control, attempt, lease.token);
      if (attempt && (control.activeAttempt!.baseFingerprint !== baseFingerprint
        || !sameCheckpoints(control.activeAttempt!.checkpoints, processed))) {
        throw new Error('Memory publication does not match the active attempt input');
      }
      const current = await readMemoryDirectory(this.currentDirectory, { memoryPath: this.#memoryPath, mode: 'read' });
      if (memoryArtifactFingerprint(current) !== baseFingerprint) {
        throw new Error('Memory changed while the dream was running');
      }
      const state = await this.readState();
      if (state.memoryFingerprint !== baseFingerprint) throw new Error('Memory state changed while the dream was running');
      await verifyLease(lease);
      await writeJson(journalPath, journal);
      await verifyLease(lease);
      {
        await rename(this.currentDirectory, previousMemory);
        const at = new Date().toISOString();
        try {
          await rename(stagedMemory, this.currentDirectory);
          if (!(await lease.verify())) throw new Error('Memory writer lease was lost after replacement');
          // The journal proves publication before any pending evidence is acknowledged.
          await writeJson(journalPath, { ...journal, phase: 'published', publishedAt: at });
          await verifyLease(lease);
          await writeState(this.statePath, acknowledgedState(state, fingerprint, processed, at));
        } catch (error) {
          await writeJson(journalPath, { ...journal, phase: 'rolled_back' });
          await restorePrevious(this, previousMemory, baseFingerprint);
          await rm(staging, { recursive: true, force: true });
          throw error;
        }
        // Once state is committed, a control-write failure must not roll canonical memory back.
        if (attempt) {
          await verifyLease(lease);
          await writeControl(this.controlPath, {
            ...control,
            activeAttempt: { ...control.activeAttempt!, published: { fingerprint, at } },
            updatedAt: at,
          });
        }
      }
    });
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

interface CommitJournal {
  readonly version: 2;
  readonly phase: 'prepared' | 'published' | 'rolled_back';
  readonly baseFingerprint: string;
  readonly fingerprint: string;
  readonly checkpoints: readonly StoredCheckpoint[];
  readonly attempt?: LocalMemoryAttemptIdentity & { readonly leaseToken: string };
  readonly publishedAt?: string;
}

async function recoverTransaction(
  store: LocalMemoryStore,
  lease: LocalMemoryLease,
  now: number,
): Promise<void> {
  await verifyLease(lease);
  await store.readControl();
  const staging = await realDirectory(store.stagingDirectory, 'Memory staging directory is unsafe; recovery is blocked');
  for (const transactionDirectory of await transactionDirectories(store.stagingDirectory)) {
    const path = transactionDirectory.path;
    const journalPath = join(path, 'commit.json');
    const journal = await readBoundedRecord(journalPath, MAX_CONTROL_BYTES, 'Memory commit journal is unsafe; recovery is blocked');
    if (!journal) {
      await verifyLease(lease);
      await verifyDirectory(staging, store.stagingDirectory, 'Memory staging directory changed; recovery is blocked');
      await verifyDirectory(transactionDirectory, path, 'Memory transaction directory changed; recovery is blocked');
      await rm(path, { recursive: true, force: true });
      continue;
    }
    if (!isLegacyCommitJournal(journal) && !isCommitJournal(journal)) {
      throw new Error('Memory commit journal is malformed or unsupported; recovery is blocked');
    }
    const current = await safeLstat(store.currentDirectory);
    if (current && (!current.isDirectory() || current.isSymbolicLink())) {
      throw new Error('Canonical memory current directory is unsafe; recovery is blocked');
    }
    const memory = join(path, 'memory');
    const previous = join(path, 'previous');
    await optionalRealDirectory(memory, 'Staged memory directory is unsafe; recovery is blocked');
    await optionalRealDirectory(previous, 'Previous memory directory is unsafe; recovery is blocked');
    await verifyLease(lease);
    if (journal.version === 1) {
      // Legacy journals have only session IDs and cannot prove which cursor was processed.
      if (!current && await safeLstat(previous)) await rename(previous, store.currentDirectory);
    } else {
      const transaction = journal as unknown as CommitJournal;
      const currentFingerprint = current
        ? await fingerprintAt(store.currentDirectory, store.memoryPath)
        : undefined;
      const state = await readState(store.statePath);
      if (!state) throw new Error('Memory state is missing during commit recovery');
      if (currentFingerprint === transaction.fingerprint
        && hasAcknowledgedCommit(state, transaction.fingerprint, transaction.checkpoints)) {
        // Durable state acknowledgement is the only proof that publication completed.
      } else if (!current || (currentFingerprint === transaction.fingerprint
        && transaction.fingerprint !== transaction.baseFingerprint)) {
        await restorePrevious(store, previous, transaction.baseFingerprint);
      }
    }
    await verifyLease(lease);
    await verifyDirectory(staging, store.stagingDirectory, 'Memory staging directory changed; recovery is blocked');
    await verifyDirectory(transactionDirectory, path, 'Memory transaction directory changed; recovery is blocked');
    await rm(path, { recursive: true, force: true });
  }
}

function acknowledgedState(
  state: LocalMemoryState,
  fingerprint: string,
  checkpoints: readonly StoredCheckpoint[],
  processedAt: string,
): LocalMemoryState {
  const pending = { ...state.pending };
  const processed = { ...state.processed };
  for (const entry of checkpoints) {
    const sessionId = entry.checkpoint.sessionId;
    if (sameStoredCheckpoint(pending[sessionId], entry)) delete pending[sessionId];
    processed[sessionId] = { ...entry, processedAt, memoryFingerprint: fingerprint };
  }
  return { ...state, memoryFingerprint: fingerprint, pending, processed, updatedAt: processedAt };
}

async function restorePrevious(store: LocalMemoryStore, previous: string, baseFingerprint: string): Promise<void> {
  const previousDirectory = await realDirectory(previous, 'Previous canonical memory is unsafe; recovery is blocked');
  if (await fingerprintAt(previous, store.memoryPath) !== baseFingerprint) {
    throw new Error('Previous canonical memory is missing or changed; recovery is blocked');
  }
  const current = await safeLstat(store.currentDirectory);
  if (current && (!current.isDirectory() || current.isSymbolicLink())) {
    throw new Error('Canonical memory current directory is unsafe; recovery is blocked');
  }
  await verifyDirectory(previousDirectory, previous, 'Previous canonical memory changed; recovery is blocked');
  await rm(store.currentDirectory, { recursive: true, force: true });
  await rename(previous, store.currentDirectory);
}

async function withStateLock<T>(store: LocalMemoryStore, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(store.statePath), { recursive: true });
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
  await writeJson(path, state);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readState(path: string): Promise<LocalMemoryState | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!isRecord(value) || value.version !== STATE_VERSION || typeof value.memoryFingerprint !== 'string'
      || !isRecord(value.pending) || !isRecord(value.processed) || typeof value.updatedAt !== 'string') {
      throw new Error('Local memory state is malformed or unsupported; processing is blocked');
    }
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
    return memoryArtifactFingerprint(await readMemoryDirectory(path, { memoryPath, mode: 'read' }));
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

type FileStat = Awaited<ReturnType<typeof lstat>>;

async function transactionDirectories(path: string): Promise<Array<{ readonly path: string; readonly stat: FileStat }>> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const directories: Array<{ path: string; stat: FileStat }> = [];
    for (const entry of entries) {
      const entryPath = join(path, entry.name);
      const stat = await lstat(entryPath);
      if (!entry.isDirectory() || entry.isSymbolicLink() || !stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('Memory staging contains an unsafe transaction entry; recovery is blocked');
      }
      directories.push({ path: entryPath, stat });
    }
    return directories;
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function readBoundedRecord(path: string, maxBytes: number, unsafeMessage: string): Promise<Record<string, unknown> | undefined> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new Error(unsafeMessage, { cause: error });
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(unsafeMessage);
    const bytes = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maxBytes) throw new Error(unsafeMessage);
    try {
      const value: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
      if (!isRecord(value)) throw new Error(unsafeMessage);
      return value;
    } catch (error) {
      if (error instanceof Error && error.message === unsafeMessage) throw error;
      throw new Error(unsafeMessage, { cause: error });
    }
  } finally {
    await file.close();
  }
}

async function realDirectory(path: string, message: string): Promise<{ readonly path: string; readonly stat: FileStat }> {
  const stat = await safeLstat(path);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(message);
  return { path, stat };
}

async function optionalRealDirectory(path: string, message: string): Promise<void> {
  const stat = await safeLstat(path);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(message);
}

async function verifyDirectory(
  expected: { readonly stat: FileStat },
  path: string,
  message: string,
): Promise<void> {
  const actual = await safeLstat(path);
  if (!actual?.isDirectory() || actual.isSymbolicLink()
    || actual.dev !== expected.stat.dev || actual.ino !== expected.stat.ino) throw new Error(message);
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

function sameStoredCheckpoint(left: StoredCheckpoint | undefined, right: StoredCheckpoint): boolean {
  return left?.recordedAt === right.recordedAt && left.checkpoint.sessionId === right.checkpoint.sessionId
    && left.checkpoint.sessionFile === right.checkpoint.sessionFile && sameCursor(left.checkpoint, right.checkpoint);
}

function sameCheckpoints(left: readonly StoredCheckpoint[], right: readonly StoredCheckpoint[]): boolean {
  return left.length === right.length && left.every((entry, index) => sameStoredCheckpoint(right[index], entry));
}

function hasAcknowledgedCommit(state: LocalMemoryState, fingerprint: string, checkpoints: readonly StoredCheckpoint[]): boolean {
  return state.memoryFingerprint === fingerprint && checkpoints.every((entry) => {
    const processed = state.processed[entry.checkpoint.sessionId];
    return sameStoredCheckpoint(processed, entry) && processed!.memoryFingerprint === fingerprint;
  });
}

async function withPublicationEvidence(store: LocalMemoryStore, control: LocalMemoryControl): Promise<LocalMemoryControl> {
  const active = control.activeAttempt;
  if (!active || active.published) return control;
  const state = await readState(store.statePath);
  if (!state || !hasAcknowledgedCommit(state, state.memoryFingerprint, active.checkpoints)
    || await fingerprintAt(store.currentDirectory, store.memoryPath) !== state.memoryFingerprint) return control;
  return {
    ...control,
    activeAttempt: { ...active, published: { fingerprint: state.memoryFingerprint, at: state.updatedAt } },
  };
}

async function verifyInitializationLease(lease: LocalMemoryLease | undefined): Promise<void> {
  if (!lease) throw new Error('Local memory initialization needs writer ownership for recovery; retry after the writer releases its lease');
  await verifyLease(lease);
}

async function verifyLease(lease: LocalMemoryLease | undefined): Promise<void> {
  if (!lease || !(await lease.verify())) throw new Error('Memory writer lease was lost');
}

function publicationAllowed(
  control: LocalMemoryControl,
  attempt: LocalMemoryAttemptIdentity | undefined,
  leaseToken: string | undefined,
): boolean {
  if (control.autoDisabled) return false;
  if (!attempt) return !control.activeAttempt;
  return control.generation === attempt.generation && sameAttempt(control.activeAttempt, attempt)
    && control.activeAttempt!.leaseToken === leaseToken;
}

function assertPublicationAllowed(control: LocalMemoryControl, attempt: LocalMemoryAttemptIdentity | undefined, token: string): void {
  if (!publicationAllowed(control, attempt, token)) throw new Error('Memory publication is disabled or the attempt was fenced');
}

function emptyControl(now: number): LocalMemoryControl {
  return { version: 1, generation: 0, consecutiveFailures: 0, updatedAt: new Date(now).toISOString() };
}

async function readControl(path: string): Promise<LocalMemoryControl | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONTROL_BYTES) throw new LocalMemoryControlError(path);
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isLocalMemoryControl(value)) throw new LocalMemoryControlError(path);
    return value;
  } catch (error) {
    if (error instanceof SyntaxError) throw new LocalMemoryControlError(path);
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function writeControl(path: string, control: LocalMemoryControl): Promise<void> {
  if (!isLocalMemoryControl(control) || Buffer.byteLength(JSON.stringify(control), 'utf8') > MAX_CONTROL_BYTES) {
    throw new LocalMemoryControlError(path);
  }
  await writeJson(path, control);
}

function finishControl(
  control: LocalMemoryControl,
  outcome: LocalMemoryAttemptOutcome,
  now: number,
  retryDelaysMs: readonly [number, number],
): LocalMemoryControl {
  const { activeAttempt, ...rest } = control;
  if (!activeAttempt) return control;
  const at = new Date(now).toISOString();
  const status = activeAttempt.published ? 'success' : outcome.status;
  const lastOutcome = { runId: activeAttempt.runId, generation: activeAttempt.generation, status, at };
  if (status === 'cancelled') {
    return { ...rest, generation: control.generation + 1, lastOutcome, updatedAt: at };
  }
  const { nextRetryAt: _retry, autoDisabled: _disabled, ...cleared } = rest;
  if (status === 'success') return {
    ...cleared,
    ...(outcome.status === 'cancelled' ? { generation: control.generation + 1 } : {}),
    consecutiveFailures: 0,
    lastOutcome,
    updatedAt: at,
  };
  const consecutiveFailures = Math.min(control.consecutiveFailures + 1, 3);
  return {
    ...cleared,
    consecutiveFailures,
    ...(consecutiveFailures === 3 ? {
      generation: control.generation + 1,
      autoDisabled: { reason: 'Three consecutive memory processing attempts failed', runId: activeAttempt.runId, at },
      lastDisabledRunId: activeAttempt.runId,
    } : { nextRetryAt: new Date(now + retryDelaysMs[consecutiveFailures - 1]!).toISOString() }),
    lastOutcome,
    updatedAt: at,
  };
}

function sameAttempt(active: LocalMemoryAttemptIdentity | undefined, identity: LocalMemoryAttemptIdentity): boolean {
  return active?.runId === identity.runId && active.generation === identity.generation;
}

function isStoredCheckpoint(value: unknown): value is StoredCheckpoint {
  if (!isRecord(value) || !isTimestamp(value.recordedAt) || !isRecord(value.checkpoint)) return false;
  const checkpoint = value.checkpoint;
  return isNonemptyString(checkpoint.sessionId) && isNonemptyString(checkpoint.sessionFile)
    && (checkpoint.leafId === null || isNonemptyString(checkpoint.leafId))
    && isNonemptyString(checkpoint.transcriptDigest);
}

function isMemoryAttempt(value: unknown): value is LocalMemoryAttempt {
  return isRecord(value) && isIdentity(value) && isNonemptyString(value.leaseToken)
    && isTimestamp(value.startedAt) && isTimestamp(value.deadlineAt)
    && Date.parse(value.deadlineAt) > Date.parse(value.startedAt)

    && isFingerprint(value.baseFingerprint) && Array.isArray(value.checkpoints)
    && value.checkpoints.length > 0 && value.checkpoints.every(isStoredCheckpoint)
    && new Set(value.checkpoints.map((entry: StoredCheckpoint) => entry.checkpoint.sessionId)).size === value.checkpoints.length
    && (value.published === undefined || (isRecord(value.published)
      && isFingerprint(value.published.fingerprint) && isTimestamp(value.published.at)));
}

function isLocalMemoryControl(value: unknown): value is LocalMemoryControl {
  if (!isRecord(value) || value.version !== 1 || !isGeneration(value.generation)
    || !Number.isInteger(value.consecutiveFailures) || Number(value.consecutiveFailures) < 0
    || Number(value.consecutiveFailures) > 3 || !isTimestamp(value.updatedAt)) return false;
  if (value.nextRetryAt !== undefined && !isTimestamp(value.nextRetryAt)) return false;
  if (value.autoDisabled !== undefined && (!isRecord(value.autoDisabled)
    || !isNonemptyString(value.autoDisabled.reason) || !isRunId(value.autoDisabled.runId)
    || !isTimestamp(value.autoDisabled.at))) return false;
  if (value.lastDisabledRunId !== undefined && (!isRunId(value.lastDisabledRunId)
    || (isRecord(value.autoDisabled) && value.autoDisabled.runId !== value.lastDisabledRunId))) return false;
  if (value.activeAttempt !== undefined && (!isMemoryAttempt(value.activeAttempt)
    || value.activeAttempt.generation !== value.generation || value.autoDisabled !== undefined)) return false;
  if (value.lastOutcome !== undefined && (!isRecord(value.lastOutcome) || !isIdentity(value.lastOutcome)
    || !['success', 'failure', 'cancelled'].includes(String(value.lastOutcome.status))
    || !isTimestamp(value.lastOutcome.at) || value.lastOutcome.generation > Number(value.generation))) return false;
  if (value.consecutiveFailures === 3) return value.autoDisabled !== undefined && value.nextRetryAt === undefined;
  return value.autoDisabled === undefined
    && (value.consecutiveFailures === 0 ? value.nextRetryAt === undefined : value.nextRetryAt !== undefined);
}

function isCommitJournal(value: Record<string, unknown>): boolean {
  return value.version === 2 && ['prepared', 'published', 'rolled_back'].includes(String(value.phase))
    && isFingerprint(value.baseFingerprint) && isFingerprint(value.fingerprint)
    && Array.isArray(value.checkpoints) && value.checkpoints.every(isStoredCheckpoint)
    && new Set(value.checkpoints.map((entry: StoredCheckpoint) => entry.checkpoint.sessionId)).size === value.checkpoints.length
    && (value.attempt === undefined || (isRecord(value.attempt) && isIdentity(value.attempt)
      && isNonemptyString(value.attempt.leaseToken)
))
    && (value.publishedAt === undefined || isTimestamp(value.publishedAt));
}

function isLegacyCommitJournal(value: Record<string, unknown>): boolean {
  return value.version === 1 && isFingerprint(value.baseFingerprint) && isFingerprint(value.fingerprint)
    && Array.isArray(value.processed) && value.processed.every(isNonemptyString);
}

function isIdentity(value: Record<string, unknown>): value is Record<string, unknown> & LocalMemoryAttemptIdentity {
  return isRunId(value.runId) && isGeneration(value.generation);
}

function isGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
}

function isRunId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]+$/u.test(value);
}

function isFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
