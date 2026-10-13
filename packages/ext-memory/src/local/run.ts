import { removeIfPresent } from './context.js';
import { pruneMemoryRuns } from './run-retention.js';
import type { MemoryContext } from './context.js';
import { randomUUID } from 'node:crypto';

import { basename, join } from 'node:path';

import { SessionManager, type Api, type Model } from '@felan-ai/agent-core';
import { sanitizeMemoryDiagnostic, type SessionCheckpoint } from '../index.js';


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
  readonly triage?: {
    readonly counts: { readonly inspect: number; readonly noise: number; readonly uncertain: number };
    readonly requests?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly costUsd?: number;
    readonly elapsedMs?: number;
  };
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


interface InspectedRetainedSession {
  readonly stat: import('@felan-ai/agent-core').RuntimeFileInfo;
  readonly lastEntryId: string | null;
  readonly latest?: Partial<MemoryRunMetadata>;
}


export class LocalMemoryRun {
  readonly directory: string;
  readonly workspace: string;
  readonly sessionManager: SessionManager;
  #metadata: MemoryRunMetadata;
  #appended = 0;
  #journalFailure: unknown;

  private constructor(readonly environment: MemoryContext, readonly options: CreateMemoryRunOptions,
    sessionManager: SessionManager,
    metadata: MemoryRunMetadata,
  ) {
    this.sessionManager = sessionManager;
    this.#metadata = metadata;
    this.directory = join(options.projectDirectory, 'runs', metadata.sessionId);
    this.workspace = join(this.directory, 'workspace');
  }

  static async reconcile(environment: MemoryContext, options: Pick<CreateMemoryRunOptions, 'projectDirectory' | 'projectKey' | 'sessionDirectory' | 'protectedRunIds'>,
    outcome: { readonly runId: string; readonly status: 'success' | 'failure' | 'cancelled'; readonly at: string },
  ): Promise<void> {
    if (!validRunId(outcome.runId)) throw new Error('Invalid memory run identity');
    const metadata = await readRetainedMetadata(environment, options, outcome.runId);
    if (!metadata) return;
    if (metadata.projectKey !== options.projectKey) throw new Error('Retained memory identity does not match the project');
    if (metadata.status !== 'started' && metadata.status !== 'worker_completed') return;
    const status: MemoryRunStatus = outcome.status === 'success' ? 'completed'
      : outcome.status === 'cancelled' ? 'cancelled' : 'failed';
    await writeRetainedMetadata(environment, options, {
      ...metadata, status, finishedAt: outcome.at,
      ...(status === 'failed' ? { error: 'The memory attempt failed before diagnostics were finalized' } : {}),
    });
    await removeTerminalWorkspace(environment, options.projectDirectory, outcome.runId);
    await pruneMemoryRuns(environment, options);
  }

  static async reconcileAbandoned(environment: MemoryContext, options: Pick<CreateMemoryRunOptions, 'projectDirectory' | 'projectKey' | 'sessionDirectory' | 'protectedRunIds'>,
    activeRunIds: readonly string[],
    now = Date.now(),
  ): Promise<void> {
    const runsDirectory = join(options.projectDirectory, 'runs');
    let entries: string[];
    try {
      const root = await environment.runtime.files!.inspect(runsDirectory);
      if (root.kind !== 'directory') throw new Error('Invalid retained memory directory');
      entries = await environment.runtime.listFiles(runsDirectory, { includeDirectories: true, includeOther: true });
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
    const active = new Set(activeRunIds);
    for (const runId of entries) {
      if (!validRunId(runId)) throw new Error('Invalid retained memory run entry');
      const directory = join(runsDirectory, runId);
      const stat = await environment.runtime.files!.inspect(directory);
      if (stat.kind !== 'directory') throw new Error('Invalid retained memory run directory');
      const metadata = await readRetainedMetadata(environment, options, runId);
      if (!metadata) throw new Error('Retained memory metadata is missing');
      if (metadata.projectKey !== options.projectKey || active.has(runId)
        || (metadata.status !== 'started' && metadata.status !== 'worker_completed')) continue;
      await writeRetainedMetadata(environment, options, {
        ...metadata,
        status: 'cancelled',
        finishedAt: new Date(now).toISOString(),
        error: 'The previous memory worker ended before completion was confirmed; evidence remains pending',
      });
      await removeTerminalWorkspace(environment, options.projectDirectory, runId);
    }
    await pruneMemoryRuns(environment, options);
  }

  static async create(environment: MemoryContext, options: CreateMemoryRunOptions): Promise<LocalMemoryRun> {
    await privateDirectory(environment, options.projectDirectory);
    await privateDirectory(environment, join(options.projectDirectory, 'runs'));
    await privateDirectory(environment, options.sessionDirectory);
    await pruneMemoryRuns(environment, options);

    const created = SessionManager.inMemory(options.projectRoot);
    const header = created.getHeader()!;
    const sessionFile = join(options.sessionDirectory, `${header.timestamp.replace(/[:.]/gu, '-')}_${header.id}.jsonl`);
    await environment.runtime.writeFile(sessionFile, new TextEncoder().encode(`${JSON.stringify(created.getHeader())}\n`), { noFollow: true, exclusive: true });
    const sessionManager = created;
    sessionManager.getSessionFile = () => sessionFile;
    sessionManager.getSessionDir = () => options.sessionDirectory;
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
    const run = new LocalMemoryRun(environment, options, sessionManager, metadata);
    await privateDirectory(environment, run.directory);
    await privateDirectory(environment, run.workspace);
    sessionManager.appendSessionInfo(`Memory: ${basename(options.projectRoot)}`);
    await run.record({});
    return run;
  }

  async flushJournal(): Promise<void> {
    if (this.#journalFailure) throw this.#journalFailure;
    const entries = this.sessionManager.getEntries();
    const text = entries.slice(this.#appended).map(entry => JSON.stringify(
      entry.type === 'message' && entry.message.role === 'assistant' && entry.message.errorMessage
        ? { ...entry, message: { ...entry.message, errorMessage: sanitizeMemoryDiagnostic(entry.message.errorMessage) } }
        : entry,
    )).join('\n');
    if (!text) return;
    try {
      await this.environment.runtime.files!.append(this.sessionManager.getSessionFile()!, new TextEncoder().encode(`${text}\n`));
      this.#appended = entries.length;
    } catch (error) {
      this.#journalFailure = error;
      throw error;
    }
  }

  get metadata(): MemoryRunMetadata { return this.#metadata; }

  async record(update: Partial<Omit<MemoryRunMetadata, 'version' | 'kind' | 'sessionId' | 'sessionFile' | 'projectKey'>>): Promise<void> {
    const next = { ...this.#metadata, ...update };
    this.sessionManager.appendCustomEntry(MEMORY_RUN_ENTRY, next);
    await this.flushJournal();
    const path = join(this.directory, 'manifest.json');
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await this.environment.runtime.writeFile(temporary, new TextEncoder().encode(`${JSON.stringify(next, null, 2)}\n`), { noFollow: true, exclusive: true });
      await this.environment.runtime.files!.move(temporary, path);
      this.#metadata = next;
    } finally {
      await removeIfPresent(this.environment, temporary);
    }
  }

  async model(model: { readonly provider: string; readonly id: string }, thinking?: string): Promise<void> {
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
    await removeIfPresent(this.environment, this.workspace, { recursive: true });
    await this.enforceRetention();
  }

  async enforceRetention(): Promise<void> {
    await pruneMemoryRuns(this.environment, {
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


async function readRetainedMetadata(environment: MemoryContext, options: Pick<CreateMemoryRunOptions, 'projectDirectory'>,
  runId: string,
): Promise<MemoryRunMetadata | undefined> {
  const path = join(options.projectDirectory, 'runs', runId, 'manifest.json');
  try {
    for (const directory of [join(options.projectDirectory, 'runs'), join(options.projectDirectory, 'runs', runId)]) {
      const info = await environment.runtime.files!.inspect(directory);
      if (info.kind !== 'directory') throw new Error('Invalid retained memory directory');
    }
    const snapshot = await environment.runtime.files!.snapshot(path, MEMORY_RUN_METADATA_BYTES);
    if (snapshot.truncated) throw new Error('Invalid retained memory metadata');
    const value: unknown = JSON.parse(new TextDecoder().decode(snapshot.content));
    if (!isMemoryRunMetadata(value, runId)) throw new Error('Invalid retained memory metadata');
    return value;
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}


async function writeRetainedMetadata(environment: MemoryContext, options: Pick<CreateMemoryRunOptions, 'projectDirectory' | 'sessionDirectory'>,
  metadata: MemoryRunMetadata,
): Promise<void> {
  if (!isMemoryRunMetadata(metadata, metadata.sessionId)) throw new Error('Invalid retained memory metadata');
  const directory = join(options.projectDirectory, 'runs', metadata.sessionId);
  const stat = await environment.runtime.files!.inspect(directory);
  if (stat.kind !== 'directory') throw new Error('Invalid retained memory run directory');
  const path = join(directory, 'manifest.json');
  await appendReconciledSessionMetadata(environment, options.sessionDirectory, metadata);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const text = `${JSON.stringify(metadata, null, 2)}\n`;
    if (Buffer.byteLength(text, 'utf8') > MEMORY_RUN_METADATA_BYTES) throw new Error('Invalid retained memory metadata');
    await environment.runtime.writeFile(temporary, new TextEncoder().encode(text), { noFollow: true, exclusive: true });
    await environment.runtime.files!.move(temporary, path);
  } finally {
    await removeIfPresent(environment, temporary);
  }
}


async function removeTerminalWorkspace(environment: MemoryContext, projectDirectory: string, runId: string): Promise<void> {
  const path = join(projectDirectory, 'runs', runId, 'workspace');
  let info: import('@felan-ai/agent-core').RuntimeFileInfo;
  try {
    info = await environment.runtime.files!.inspect(path);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  if (info.kind === 'symlink') {
    await removeIfPresent(environment, path);
    return;
  }
  if (info.kind !== 'directory') throw new Error('Invalid retained memory workspace');
  await removeIfPresent(environment, path, { recursive: true });
}


async function appendReconciledSessionMetadata(environment: MemoryContext, sessionDirectory: string, metadata: MemoryRunMetadata): Promise<void> {
  const directory = await environment.runtime.files!.inspect(sessionDirectory);
  if (directory.kind !== 'directory') throw new Error('Invalid retained memory session directory');
  const sessionPath = join(sessionDirectory, metadata.sessionFile);
  const inspected = await inspectRetainedSession(environment, sessionPath, metadata);
  const latest = inspected.latest;
  if (latest?.status === metadata.status && latest.finishedAt === metadata.finishedAt) return;
  await environment.runtime.files!.append(sessionPath, new TextEncoder().encode(`${JSON.stringify({
    type: 'custom', customType: MEMORY_RUN_ENTRY, data: metadata, id: randomUUID(),
    parentId: inspected.lastEntryId, timestamp: new Date().toISOString(),
  })}\n`), inspected.stat);
}


async function inspectRetainedSession(environment: MemoryContext, sessionPath: string,
  metadata: MemoryRunMetadata,
): Promise<InspectedRetainedSession> {
  const snapshot = await environment.runtime.files!.snapshot(sessionPath, MEMORY_RUN_RECONCILE_SESSION_BYTES);
  if (snapshot.truncated) throw new Error('Invalid or oversized retained memory session file');
  const text = new TextDecoder().decode(snapshot.content);
  const opened = snapshot.info;
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


async function privateDirectory(environment: MemoryContext, path: string): Promise<void> {
  await environment.runtime.files!.ensurePrivateDirectory(path, { recursive: true });
}


