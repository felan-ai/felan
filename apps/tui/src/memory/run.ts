import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { SessionManager, type Api, type Model } from '@felan-ai/agent-core';
import type { SessionCheckpoint } from '@felan-ai/ext-memory';
import { pruneMemoryRuns } from './run-retention.js';

export const MEMORY_RUN_ENTRY = 'felan-memory-run';
export type MemoryRunStatus = 'started' | 'worker_completed' | 'completed' | 'failed' | 'cancelled' | 'blocked' | 'interrupted';
export type MemoryRunPhase = 'materialize' | 'model' | 'validate' | 'publish';

export interface MemoryRunUsage {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly totalTokens?: number;
  readonly costUsd?: number;
}

export interface MemoryRunMetadata {
  readonly version: 1;
  readonly kind: 'memory';
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly projectKey: string;
  readonly projectRoot: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly status: MemoryRunStatus;
  readonly phase: MemoryRunPhase;
  readonly checkpoints: readonly SessionCheckpoint[];
  readonly baseFingerprint: string;
  readonly outputFingerprint?: string;
  readonly model?: { readonly provider: string; readonly id: string; readonly thinking?: string };
  readonly usage?: MemoryRunUsage;
  readonly error?: string;
}

export interface CreateMemoryRunOptions {
  readonly projectDirectory: string;
  readonly sessionDirectory: string;
  readonly projectKey: string;
  readonly projectRoot: string;
  readonly checkpoints: readonly SessionCheckpoint[];
  readonly baseFingerprint: string;
  readonly protectedRunIds?: readonly string[];
}

export class LocalMemoryRun {
  readonly directory: string;
  readonly workspace: string;
  readonly sessionManager: SessionManager;
  #metadata: MemoryRunMetadata;

  private constructor(
    readonly options: CreateMemoryRunOptions,
    sessionManager: SessionManager,
    metadata: MemoryRunMetadata,
  ) {
    this.sessionManager = sessionManager;
    this.#metadata = metadata;
    this.directory = join(options.projectDirectory, 'runs', metadata.sessionId);
    this.workspace = join(this.directory, 'workspace');
  }

  static async reconcile(
    options: Pick<CreateMemoryRunOptions, 'projectDirectory' | 'projectKey' | 'sessionDirectory' | 'protectedRunIds'>,
    outcome: { readonly runId: string; readonly status: 'success' | 'failure' | 'cancelled'; readonly at: string },
  ): Promise<void> {
    if (!validRunId(outcome.runId)) throw new Error('Invalid memory run identity');
    const metadata = await readRetainedMetadata(options, outcome.runId);
    if (!metadata) return;
    if (metadata.projectKey !== options.projectKey) throw new Error('Retained memory identity does not match the project');
    if (metadata.status !== 'started' && metadata.status !== 'worker_completed') return;
    const status: MemoryRunStatus = outcome.status === 'success' ? 'completed'
      : outcome.status === 'cancelled' ? 'cancelled' : 'failed';
    await writeRetainedMetadata(options, {
      ...metadata, status, finishedAt: outcome.at,
      ...(status === 'failed' ? { error: 'The memory attempt failed before diagnostics were finalized' } : {}),
    });
    await removeTerminalWorkspace(options.projectDirectory, outcome.runId);
    await pruneMemoryRuns(options);
  }

  static async reconcileAbandoned(
    options: Pick<CreateMemoryRunOptions, 'projectDirectory' | 'projectKey' | 'sessionDirectory' | 'protectedRunIds'>,
    activeRunIds: readonly string[],
    now = Date.now(),
  ): Promise<void> {
    const runsDirectory = join(options.projectDirectory, 'runs');
    let entries: string[];
    try {
      const root = await lstat(runsDirectory);
      if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Invalid retained memory directory');
      entries = await readdir(runsDirectory);
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
    const active = new Set(activeRunIds);
    for (const runId of entries) {
      if (!validRunId(runId)) throw new Error('Invalid retained memory run entry');
      const directory = join(runsDirectory, runId);
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid retained memory run directory');
      const metadata = await readRetainedMetadata(options, runId);
      if (!metadata) throw new Error('Retained memory metadata is missing');
      if (metadata.projectKey !== options.projectKey || active.has(runId)
        || (metadata.status !== 'started' && metadata.status !== 'worker_completed')) continue;
      await writeRetainedMetadata(options, {
        ...metadata,
        status: 'cancelled',
        finishedAt: new Date(now).toISOString(),
        error: 'The previous memory worker ended before completion was confirmed; evidence remains pending',
      });
      await removeTerminalWorkspace(options.projectDirectory, runId);
    }
    await pruneMemoryRuns(options);
  }

  static async create(options: CreateMemoryRunOptions): Promise<LocalMemoryRun> {
    await privateDirectory(options.projectDirectory);
    await privateDirectory(join(options.projectDirectory, 'runs'));
    await privateDirectory(options.sessionDirectory);
    await pruneMemoryRuns(options);

    const created = SessionManager.create(options.projectRoot, options.sessionDirectory);
    const sessionFile = created.getSessionFile();
    if (!sessionFile) throw new Error('Memory session file could not be created');
    await writeFile(sessionFile, `${JSON.stringify(created.getHeader())}\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    const sessionManager = SessionManager.open(sessionFile, options.sessionDirectory, options.projectRoot);
    const metadata: MemoryRunMetadata = {
      version: 1,
      kind: 'memory',
      sessionId: sessionManager.getSessionId(),
      sessionFile: basename(sessionFile),
      projectKey: options.projectKey,
      projectRoot: options.projectRoot,
      startedAt: new Date().toISOString(),
      status: 'started',
      phase: 'materialize',
      checkpoints: options.checkpoints,
      baseFingerprint: options.baseFingerprint,
    };
    const run = new LocalMemoryRun(options, sessionManager, metadata);
    await privateDirectory(run.directory);
    await privateDirectory(run.workspace);
    sessionManager.appendSessionInfo(`Memory: ${basename(options.projectRoot)}`);
    await run.record({});
    return run;
  }

  get metadata(): MemoryRunMetadata { return this.#metadata; }

  async record(update: Partial<Omit<MemoryRunMetadata, 'version' | 'kind' | 'sessionId' | 'sessionFile' | 'projectKey'>>): Promise<void> {
    const next = { ...this.#metadata, ...update };
    this.sessionManager.appendCustomEntry(MEMORY_RUN_ENTRY, next);
    const path = join(this.directory, 'manifest.json');
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
      this.#metadata = next;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async model(model: Model<Api>, thinking?: string): Promise<void> {
    await this.record({
      phase: 'model',
      ...(model.provider && model.id ? {
        model: { provider: model.provider, id: model.id, ...(thinking ? { thinking } : {}) },
      } : {}),
    });
  }

  async finish(status: MemoryRunStatus, error?: unknown): Promise<void> {
    await this.record({
      status,
      finishedAt: new Date().toISOString(),
      ...(error === undefined ? {} : { error: sanitizeMemoryDiagnostic(error) }),
    });
    await rm(this.workspace, { recursive: true, force: true });
    await this.enforceRetention();
  }

  async enforceRetention(): Promise<void> {
    await pruneMemoryRuns({
      ...this.options,
      protectedRunIds: [...(this.options.protectedRunIds ?? []), this.metadata.sessionId],
    });
  }
}

const MEMORY_RUN_METADATA_BYTES = 64 * 1_024;
const MEMORY_RUN_RECONCILE_SESSION_BYTES = 16 * 1_024 * 1_024;
const MEMORY_RUN_STATUSES = new Set<MemoryRunStatus>([
  'started', 'worker_completed', 'completed', 'failed', 'cancelled', 'blocked', 'interrupted',
]);
const MEMORY_RUN_PHASES = new Set<MemoryRunPhase>(['materialize', 'model', 'validate', 'publish']);

async function readRetainedMetadata(
  options: Pick<CreateMemoryRunOptions, 'projectDirectory'>,
  runId: string,
): Promise<MemoryRunMetadata | undefined> {
  const path = join(options.projectDirectory, 'runs', runId, 'manifest.json');
  let file: Awaited<ReturnType<typeof open>>;
  try {
    for (const directory of [join(options.projectDirectory, 'runs'), join(options.projectDirectory, 'runs', runId)]) {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid retained memory directory');
    }
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MEMORY_RUN_METADATA_BYTES) {
      throw new Error('Invalid retained memory metadata');
    }
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MEMORY_RUN_METADATA_BYTES) throw new Error('Invalid retained memory metadata');
    const bytes = Buffer.alloc(MEMORY_RUN_METADATA_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MEMORY_RUN_METADATA_BYTES) throw new Error('Invalid retained memory metadata');
    let value: unknown;
    try {
      value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    } catch {
      throw new Error('Invalid retained memory metadata');
    }
    if (!isMemoryRunMetadata(value, runId)) throw new Error('Invalid retained memory metadata');
    return value;
  } finally {
    await file.close();
  }
}

async function writeRetainedMetadata(
  options: Pick<CreateMemoryRunOptions, 'projectDirectory' | 'sessionDirectory'>,
  metadata: MemoryRunMetadata,
): Promise<void> {
  if (!isMemoryRunMetadata(metadata, metadata.sessionId)) throw new Error('Invalid retained memory metadata');
  const directory = join(options.projectDirectory, 'runs', metadata.sessionId);
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid retained memory run directory');
  const path = join(directory, 'manifest.json');
  await appendReconciledSessionMetadata(options.sessionDirectory, metadata);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const text = `${JSON.stringify(metadata, null, 2)}\n`;
    if (Buffer.byteLength(text, 'utf8') > MEMORY_RUN_METADATA_BYTES) throw new Error('Invalid retained memory metadata');
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function removeTerminalWorkspace(projectDirectory: string, runId: string): Promise<void> {
  const path = join(projectDirectory, 'runs', runId, 'workspace');
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  if (info.isSymbolicLink()) {
    await rm(path, { force: true });
    return;
  }
  if (!info.isDirectory()) throw new Error('Invalid retained memory workspace');
  await rm(path, { recursive: true, force: true });
}

async function appendReconciledSessionMetadata(sessionDirectory: string, metadata: MemoryRunMetadata): Promise<void> {
  const directory = await lstat(sessionDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Invalid retained memory session directory');
  const sessionPath = join(sessionDirectory, metadata.sessionFile);
  const inspected = await inspectRetainedSession(sessionPath, metadata);
  const latest = inspected.latest;
  if (latest?.status === metadata.status && latest.finishedAt === metadata.finishedAt) return;
  const file = await open(
    sessionPath,
    constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !sameFile(stat, inspected.stat) || stat.size !== inspected.stat.size) {
      throw new Error('Retained memory session changed during reconciliation');
    }
    await file.write(`${JSON.stringify({
      type: 'custom',
      customType: MEMORY_RUN_ENTRY,
      data: metadata,
      id: randomUUID(),
      parentId: inspected.lastEntryId,
      timestamp: new Date().toISOString(),
    })}\n`);
  } finally {
    await file.close();
  }
}

interface InspectedRetainedSession {
  readonly stat: Awaited<ReturnType<typeof lstat>>;
  readonly lastEntryId: string | null;
  readonly latest?: Partial<MemoryRunMetadata>;
}

async function inspectRetainedSession(
  sessionPath: string,
  metadata: MemoryRunMetadata,
): Promise<InspectedRetainedSession> {
  const initial = await lstat(sessionPath);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size > MEMORY_RUN_RECONCILE_SESSION_BYTES) {
    throw new Error('Invalid or oversized retained memory session file');
  }
  const file = await open(
    sessionPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  let text: string;
  let opened: Awaited<ReturnType<typeof lstat>>;
  try {
    opened = await file.stat();
    if (!opened.isFile() || !sameFile(initial, opened) || opened.size !== initial.size
      || opened.size > MEMORY_RUN_RECONCILE_SESSION_BYTES) {
      throw new Error('Retained memory session changed during reconciliation');
    }
    const bytes = Buffer.alloc(opened.size);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const current = await lstat(sessionPath);
    if (length !== opened.size || !sameFile(opened, current) || current.size !== opened.size
      || current.mtimeMs !== opened.mtimeMs) {
      throw new Error('Retained memory session changed during reconciliation');
    }
    text = bytes.toString('utf8');
  } finally {
    await file.close();
  }
  if (!text.endsWith('\n')) throw new Error('Retained memory session is incomplete');
  const lines = text.slice(0, -1).split('\n');
  const header = parseRecord(lines.shift());
  if (header?.type !== 'session' || header.id !== metadata.sessionId || header.cwd !== metadata.projectRoot) {
    throw new Error('Retained memory session identity does not match its metadata');
  }
  const ids = new Set<string>();
  let ownershipProven = false;
  let latest: Partial<MemoryRunMetadata> | undefined;
  let lastEntryId: string | null = null;
  for (const line of lines) {
    const entry = parseRecord(line);
    if (!entry || typeof entry.type !== 'string' || typeof entry.id !== 'string' || ids.has(entry.id)
      || (entry.parentId !== null && (typeof entry.parentId !== 'string' || !ids.has(entry.parentId)))) {
      throw new Error('Invalid retained memory session entries');
    }
    ids.add(entry.id);
    lastEntryId = entry.id;
    if (!ownershipProven) {
      if (entry.type === 'custom' && entry.customType === MEMORY_RUN_ENTRY) {
        if (!matchingMemoryMarker(entry.data, metadata)) throw new Error('Retained memory session ownership is unverified');
        ownershipProven = true;
      } else if (!['session_info', 'model_change', 'thinking_level_change'].includes(entry.type)) {
        throw new Error('Retained memory session ownership is unverified');
      }
    }
    if (entry.type === 'custom' && entry.customType === MEMORY_RUN_ENTRY
      && matchingMemoryMarker(entry.data, metadata)) latest = entry.data;
  }
  if (!ownershipProven) throw new Error('Retained memory session ownership is unverified');
  return { stat: opened, lastEntryId, ...(latest ? { latest } : {}) };
}

function matchingMemoryMarker(value: unknown, metadata: MemoryRunMetadata): value is MemoryRunMetadata {
  return isMemoryRunMetadata(value, metadata.sessionId)
    && value.sessionFile === metadata.sessionFile
    && value.projectKey === metadata.projectKey
    && value.projectRoot === metadata.projectRoot;
}

function parseRecord(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function sameFile(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isMemoryRunMetadata(value: unknown, runId: string): value is MemoryRunMetadata {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<MemoryRunMetadata>;
  return data.version === 1 && data.kind === 'memory' && data.sessionId === runId
    && validRunId(runId) && typeof data.sessionFile === 'string' && basename(data.sessionFile) === data.sessionFile
    && typeof data.projectKey === 'string' && typeof data.projectRoot === 'string'
    && typeof data.startedAt === 'string' && Number.isFinite(Date.parse(data.startedAt))
    && typeof data.status === 'string' && MEMORY_RUN_STATUSES.has(data.status as MemoryRunStatus)
    && typeof data.phase === 'string' && MEMORY_RUN_PHASES.has(data.phase as MemoryRunPhase)
    && typeof data.baseFingerprint === 'string' && Array.isArray(data.checkpoints)
    && data.checkpoints.every((checkpoint) => checkpoint && typeof checkpoint === 'object'
      && typeof checkpoint.sessionId === 'string' && typeof checkpoint.sessionFile === 'string'
      && (checkpoint.leafId === null || typeof checkpoint.leafId === 'string')
      && typeof checkpoint.transcriptDigest === 'string')
    && (data.finishedAt === undefined || (typeof data.finishedAt === 'string' && Number.isFinite(Date.parse(data.finishedAt))))
    && (data.error === undefined || typeof data.error === 'string');
}

function validRunId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
}

function isMissingFile(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

export function memoryRunUsage(entries: ReturnType<SessionManager['getEntries']>): MemoryRunUsage | undefined {
  const result: Partial<Record<keyof MemoryRunUsage, number>> = {};
  for (const entry of entries) {
    const usage = entry.type === 'compaction' ? entry.usage
      : entry.type === 'message' && entry.message.role === 'assistant' ? entry.message.usage : undefined;
    if (!usage) continue;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) {
      const value = usage[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[key] = (result[key] ?? 0) + value;
    }
    const cost = usage.cost?.total;
    if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) result.costUsd = (result.costUsd ?? 0) + cost;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function sanitizeMemoryDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu, '[REDACTED_PRIVATE_KEY]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/gu, '[REDACTED_TOKEN]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, '$1[REDACTED_TOKEN]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}]+/giu, '$1[REDACTED_SECRET]')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '')
    .slice(0, 4_000);
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Memory diagnostic directory must be a regular directory');
  await chmod(path, 0o700);
}
