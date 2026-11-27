import { createHash, randomBytes } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import type { AgentRuntime, AgentRuntimeStorage } from '@felan-ai/agent-core';
import { BackgroundBashRetention } from './retention.js';

export type BackgroundBashStatus = 'running' | 'completed' | 'failed' | 'killed' | 'unknown';
export type BackgroundBashStatusFilter = BackgroundBashStatus | 'all';
export type BackgroundBashNotice = 'pending' | 'delivered';

export interface BackgroundBashQuery {
  limit?: number;
  cursor?: string;
  status?: BackgroundBashStatusFilter;
  search?: string;
}

export interface BackgroundBashPage {
  jobs: BackgroundBashJob[];
  hasMore: boolean;
  nextCursor?: string;
  scanned: number;
}

const BACKGROUND_BASH_QUERY_LIMIT = 100;
/** @internal */
export const BACKGROUND_BASH_SCAN_LIMIT = 100;

export interface BackgroundBashInfo {
  id: string;
  command: string;
  cwd: string;
  jobDir: string;
  logPath: string;
  infoPath: string;
  completionPath: string;
  commandPath: string;
  runnerPath: string;
  shell: string;
  shellArgs: string[];
  startedAt: number;
  updatedAt: number;
  status: BackgroundBashStatus;
  executionMode?: 'detached' | 'pty' | 'attached';
  promotedAt?: number;
  outputTruncated?: boolean;
  foreground?: string;
  notice?: BackgroundBashNotice;
  noticeSession?: string;
  pid?: number;
  processGroupId?: number;
  processToken?: string;
  creatorPid: number;
  exitCode?: number | null;
  signal?: string | null;
  completedAt?: number;
  error?: string;
}

export interface BackgroundBashMeta {
  id: string;
  command: string;
  cwd: string;
  jobDir: string;
  logPath: string;
  infoPath: string;
  completionPath: string;
  commandPath: string;
  runnerPath: string;
  shell: string;
  shellArgs: string[];
  startedAt: number;
  pid?: number;
  processGroupId?: number;
  processToken?: string;
  creatorPid: number;
  executionMode?: 'detached' | 'pty' | 'attached';
  promotedAt?: number;
  outputTruncated?: boolean;
  /** Identifies the process whose foreground tool call waits on the job; such jobs are not listed until promoted. */
  foreground?: string;
  notice?: BackgroundBashNotice;
  /** The session that receives the finish notice. */
  noticeSession?: string;
}

export interface BackgroundBashStatusFile {
  id: string;
  status: BackgroundBashStatus;
  startedAt: number;
  updatedAt: number;
  pid?: number;
  exitCode?: number | null;
  signal?: string | null;
  completedAt?: number;
  error?: string;
  executionMode?: 'detached' | 'pty' | 'attached';
  promotedAt?: number;
  outputTruncated?: boolean;
}

export interface BackgroundBashJob {
  meta: BackgroundBashMeta;
  status: BackgroundBashStatusFile;
  info: BackgroundBashInfo;
}

const STATUS_VALUES: ReadonlySet<string> = new Set([
  'running',
  'completed',
  'failed',
  'killed',
  'unknown',
]);
const TERMINAL_STATUSES: ReadonlySet<BackgroundBashStatus> = new Set([
  'completed',
  'failed',
  'killed',
  'unknown',
]);
const JOB_ID_PATTERN = /^bash-\d{14}-[a-f0-9]{6}$/u;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const jobOperations = new Map<string, Promise<void>>();

function getBackgroundBashWorkspaceKey(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  const label = basename(resolvedCwd)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48) || 'workspace';
  const digest = createHash('sha256').update(resolvedCwd).digest('hex').slice(0, 12);
  return `${label}-${digest}`;
}

/** @internal */
export function getBackgroundBashRoot(storageRoot: string, cwd: string): string {
  return join(storageRoot, 'background-bash', getBackgroundBashWorkspaceKey(cwd));
}

/** @internal */
export function getBackgroundBashJobsDir(storageRoot: string, cwd: string): string {
  return join(getBackgroundBashRoot(storageRoot, cwd), 'jobs');
}

export function isBackgroundBashJobId(id: string): boolean {
  return JOB_ID_PATTERN.test(id);
}

export function isTerminalStatus(status: BackgroundBashStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function generateJobId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14);
  return `bash-${stamp}-${randomBytes(3).toString('hex')}`;
}

export class BackgroundBashJobStore {
  readonly rootDir: string;
  readonly jobsDir: string;
  readonly #storage: AgentRuntimeStorage;
  readonly #retention: BackgroundBashRetention;

  constructor(
    private readonly runtime: AgentRuntime,
    storage: AgentRuntimeStorage,
  ) {
    this.#storage = storage;
    this.rootDir = getBackgroundBashRoot(this.#storage.root, runtime.cwd);
    this.jobsDir = getBackgroundBashJobsDir(this.#storage.root, runtime.cwd);
    this.#retention = new BackgroundBashRetention(runtime, storage, this.jobsDir, () => this.listIds(), (id, operation) => this.withJob(id, operation));
  }

  async createJob(
    command: string,
    executionMode: 'detached' | 'pty' = 'detached',
    options?: { foreground?: string; noticeSession?: string },
  ): Promise<BackgroundBashJob> {
    await this.#storage.mkdir(this.jobsDir, { recursive: true });

    let id = generateJobId();
    let jobDir = join(this.jobsDir, id);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await this.#storage.mkdir(jobDir);
        break;
      } catch (error) {
        if (!isAlreadyExistsError(error) || attempt === 4) throw error;
        id = generateJobId();
        jobDir = join(this.jobsDir, id);
      }
    }

    const info = this.#buildInfo(id, jobDir, command, executionMode, options);
    const job = await this.withJob(id, async () => {
      if (info.notice === 'pending') await this.writeNoticeMarker(id);
      await this.writeInfo(info);
      return jobFromInfo(info);
    });
    await this.#retention.recordMutation();
    return job;
  }

  /** Builds the record of a new job without writing it, for a caller that creates the job directory in one runtime call. */
  prepareJob(command: string, options?: { foreground?: string; noticeSession?: string }): BackgroundBashInfo {
    const id = generateJobId();
    return this.#buildInfo(id, join(this.jobsDir, id), command, 'detached', options);
  }

  /** Counts a job created outside `createJob` toward retention. */
  async recordCreated(): Promise<void> {
    await this.#retention.recordMutation();
  }

  #buildInfo(
    id: string,
    jobDir: string,
    command: string,
    executionMode: 'detached' | 'pty',
    options?: { foreground?: string; noticeSession?: string },
  ): BackgroundBashInfo {
    const now = Date.now();
    return {
      id,
      command,
      cwd: this.runtime.cwd,
      jobDir,
      logPath: join(jobDir, 'output.log'),
      infoPath: join(jobDir, 'info.json'),
      completionPath: join(jobDir, 'completion.json'),
      commandPath: join(jobDir, 'command.sh'),
      runnerPath: join(jobDir, 'runner.sh'),
      shell: 'sh',
      shellArgs: [],
      startedAt: now,
      updatedAt: now,
      status: 'running',
      executionMode,
      creatorPid: process.pid,
      processToken: randomBytes(16).toString('hex'),
      ...(options?.foreground === undefined ? {} : { foreground: options.foreground }),
      ...(options?.noticeSession === undefined ? {} : { notice: 'pending' as const, noticeSession: options.noticeSession }),
    };
  }

  async readJob(id: string): Promise<BackgroundBashJob | undefined> {
    return this.withJob(id, () => this.readStoredJob(id));
  }

  async listJobs(status: BackgroundBashStatusFilter = 'all'): Promise<BackgroundBashJob[]> {
    const ids = await this.listIds();
    const jobs: BackgroundBashJob[] = [];
    for (const id of ids) {
      const job = await this.readJob(id);
      if (!job || job.meta.foreground !== undefined) continue;
      if (status !== 'all' && job.status.status !== status) continue;
      jobs.push(job);
    }
    jobs.sort((a, b) => b.meta.startedAt - a.meta.startedAt);
    return jobs;
  }

  async query(
    options: BackgroundBashQuery = {},
    refresh?: (job: BackgroundBashJob) => Promise<BackgroundBashJob>,
  ): Promise<BackgroundBashPage> {
    const limit = options.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > BACKGROUND_BASH_QUERY_LIMIT) {
      throw new Error(`Process query limit must be between 1 and ${BACKGROUND_BASH_QUERY_LIMIT}.`);
    }
    if (options.cursor !== undefined && !isBackgroundBashJobId(options.cursor)) throw new Error('Invalid process query cursor.');
    if (options.status !== undefined && options.status !== 'all' && !STATUS_VALUES.has(options.status)) throw new Error('Invalid process query status.');
    if (options.search !== undefined && (typeof options.search !== 'string' || options.search.length > 256)) throw new Error('Process search must be at most 256 characters.');
    const ids = await this.listIds();
    const candidates = options.cursor === undefined ? ids : ids.filter(id => id < options.cursor!);
    const search = options.search?.trim().toLowerCase();
    const cache = new Map<string, BackgroundBashJob | undefined>();
    const read = async (id: string) => {
      if (!cache.has(id)) {
        const job = await this.readJob(id);
        cache.set(id, job && refresh ? await refresh(job) : job);
      }
      return cache.get(id);
    };
    const matches = (job: BackgroundBashJob) => job.meta.foreground === undefined
      && (options.status === undefined || options.status === 'all' || job.status.status === options.status)
      && (!search || `${job.meta.id}\n${job.meta.command}`.toLowerCase().includes(search));
    const jobs: BackgroundBashJob[] = [];
    let scanned = 0;
    for (const id of candidates) {
      const job = await read(id);
      scanned++;
      if (job && matches(job)) jobs.push(job);
      if (jobs.length === limit || scanned === BACKGROUND_BASH_SCAN_LIMIT) break;
    }
    const hasMore = scanned < candidates.length;
    const page: BackgroundBashPage = {
      jobs, hasMore, scanned,
      ...(hasMore ? { nextCursor: candidates[scanned - 1]! } : {}),
    };
    return page;
  }

  private async listIds(): Promise<string[]> {
    await this.#storage.mkdir(this.jobsDir, { recursive: true });
    const entries = await this.#storage.listFiles(this.jobsDir, { recursive: false, includeDirectories: true });
    return [...new Set(entries.filter(isBackgroundBashJobId))].sort().reverse();
  }

  async updatePid(
    id: string,
    pid: number,
    processGroupId?: number,
    options?: { executionMode?: 'detached' | 'pty'; promotedAt?: number },
  ): Promise<BackgroundBashJob | undefined> {
    return this.withJob(id, async () => {
      const job = await this.readStoredJob(id);
      if (!job) return undefined;
      const info: BackgroundBashInfo = {
        ...job.info,
        pid,
        ...(processGroupId === undefined ? {} : { processGroupId }),
        ...(options?.executionMode === undefined ? {} : { executionMode: options.executionMode }),
        ...(options?.promotedAt === undefined ? {} : { promotedAt: options.promotedAt }),
        updatedAt: isTerminalStatus(job.status.status) ? job.status.updatedAt : Date.now(),
      };
      await this.writeInfo(info);
      return jobFromInfo(info);
    });
  }

  async markStatus(
    id: string,
    patch: Partial<BackgroundBashStatusFile> & { status: BackgroundBashStatus },
  ): Promise<BackgroundBashJob | undefined> {
    let changed = false;
    const result = await this.withJob(id, async () => {
      const job = await this.readStoredJob(id);
      if (!job) return undefined;
      if (isTerminalStatus(job.status.status)) return job;
      const now = Date.now();
      const status: BackgroundBashStatusFile = {
        ...job.status,
        ...patch,
        id,
        status: patch.status,
        startedAt: job.status.startedAt,
        updatedAt: now,
        ...(patch.completedAt === undefined && isTerminalStatus(patch.status)
          ? { completedAt: now }
          : {}),
      };
      const info = mergeStatus(job.info, status);
      await this.writeStatus(info.completionPath, status);
      await this.writeInfo(info);
      changed = true;
      return jobFromInfo(info);
    });
    if (changed) await this.#retention.recordMutation();
    return result;
  }

  async markRunning(
    id: string,
    executionMode: 'detached' | 'pty',
    promotedAt: number,
  ): Promise<BackgroundBashJob | undefined> {
    return this.withJob(id, async () => {
      const job = await this.readStoredJob(id);
      if (!job) return undefined;
      const { foreground, ...rest } = job.info;
      if (isTerminalStatus(job.status.status)) {
        // A foreground job that finished unwatched becomes listed without changing its outcome.
        if (foreground === undefined) return job;
        await this.writeInfo(rest);
        return jobFromInfo(rest);
      }
      const info: BackgroundBashInfo = {
        ...rest,
        status: 'running',
        executionMode,
        promotedAt,
        updatedAt: Date.now(),
      };
      await this.writeInfo(info);
      return jobFromInfo(info);
    });
  }

  /** Records that `session` is owed a finish notice for the job. */
  async watchNotice(id: string, session: string): Promise<BackgroundBashJob | undefined> {
    return this.withJob(id, async () => {
      const job = await this.readStoredJob(id);
      if (!job || (job.info.notice === 'pending' && job.info.noticeSession === session)) return job;
      const info: BackgroundBashInfo = { ...job.info, notice: 'pending', noticeSession: session };
      await this.writeNoticeMarker(id);
      await this.writeInfo(info);
      return jobFromInfo(info);
    });
  }

  /** Marks the pending notice of `session` delivered; only the call that changes it returns true. */
  async settleNotice(id: string, session: string): Promise<boolean> {
    return this.withJob(id, async () => {
      const job = await this.readStoredJob(id);
      if (!job || job.info.notice !== 'pending' || job.info.noticeSession !== session) return false;
      await this.writeInfo({ ...job.info, notice: 'delivered' });
      await this.removeNoticeMarker(id);
      return true;
    });
  }

  /** Jobs that still owe a finish notice, to `session` when given, found through the notice index rather than a full job scan. */
  async pendingNotices(session?: string): Promise<BackgroundBashJob[]> {
    await this.#storage.mkdir(this.noticesDir, { recursive: true });
    const ids = await this.#storage.listFiles(this.noticesDir, { recursive: false });
    const present = new Set(await this.listIds());
    const jobs: BackgroundBashJob[] = [];
    for (const id of new Set(ids.filter(isBackgroundBashJobId))) {
      const job = await this.withJob(id, async () => {
        if (!present.has(id)) {
          await this.removeNoticeMarker(id);
          return undefined;
        }
        // An unreadable record keeps its marker; only a record that no longer owes a notice drops it.
        const stored = await this.readStoredJob(id);
        if (stored && stored.info.notice !== 'pending') await this.removeNoticeMarker(id);
        return stored?.info.notice === 'pending' ? stored : undefined;
      });
      if (job && (session === undefined || job.info.noticeSession === session)) jobs.push(job);
    }
    jobs.sort((a, b) => a.meta.startedAt - b.meta.startedAt);
    return jobs;
  }

  async removeJob(id: string): Promise<void> {
    if (!isBackgroundBashJobId(id)) return;
    await this.withJob(id, async () => {
      await this.removeNoticeMarker(id);
      await this.#storage.remove(join(this.jobsDir, id), { recursive: true });
    });
  }

  get noticesDir(): string {
    return join(this.rootDir, 'notices');
  }

  private async writeNoticeMarker(id: string): Promise<void> {
    await this.#storage.mkdir(this.noticesDir, { recursive: true });
    await this.#storage.writeFile(join(this.noticesDir, id), new Uint8Array());
  }

  /** The marker only indexes pending notices; `info.json` stays authoritative, so a marker that outlives its notice is harmless. */
  private async removeNoticeMarker(id: string): Promise<void> {
    await this.#storage.remove(join(this.noticesDir, id)).catch(() => {});
  }

  private async withJob<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const key = resolve(this.jobsDir, id);
    const pending = (jobOperations.get(key) ?? Promise.resolve()).then(operation);
    const settled = pending.then(() => {}, () => {});
    jobOperations.set(key, settled);
    try {
      return await pending;
    } finally {
      if (jobOperations.get(key) === settled) jobOperations.delete(key);
    }
  }

  private async readStoredJob(id: string): Promise<BackgroundBashJob | undefined> {
    if (!isBackgroundBashJobId(id)) return undefined;
    const jobDir = join(this.jobsDir, id);
    const info = normalizeInfo(await readJson(this.#storage, join(jobDir, 'info.json')), id, jobDir);
    if (info) {
      const completion = normalizeStatus(
        await readJson(this.#storage, info.completionPath),
        info,
      );
      if (completion && isTerminalStatus(completion.status)) {
        const completedInfo = mergeStatus(info, completion);
        if (info.status === 'running') await this.writeInfo(completedInfo);
        return jobFromInfo(completedInfo);
      }
      return jobFromInfo(info);
    }

    return this.readLegacyJob(id, jobDir);
  }

  private async readLegacyJob(id: string, jobDir: string): Promise<BackgroundBashJob | undefined> {
    const meta = await readJson(this.#storage, join(jobDir, 'meta.json'));
    if (!isRecord(meta) || meta.id !== id || typeof meta.command !== 'string') return undefined;

    const startedAt = numberValue(meta.startedAt) ?? Date.now();
    const baseInfo: BackgroundBashInfo = {
      id,
      command: meta.command,
      cwd: typeof meta.cwd === 'string' ? meta.cwd : this.runtime.cwd,
      jobDir,
      logPath: join(jobDir, 'output.log'),
      infoPath: join(jobDir, 'info.json'),
      completionPath: join(jobDir, 'completion.json'),
      commandPath: join(jobDir, 'command.sh'),
      runnerPath: join(jobDir, 'runner.sh'),
      shell: typeof meta.shell === 'string' ? meta.shell : 'sh',
      shellArgs: stringArray(meta.shellArgs),
      startedAt,
      updatedAt: startedAt,
      status: 'unknown',
      executionMode: executionMode(meta.executionMode),
      ...(numberValue(meta.promotedAt) === undefined ? {} : { promotedAt: numberValue(meta.promotedAt)! }),
      ...(typeof meta.outputTruncated !== 'boolean' ? {} : { outputTruncated: meta.outputTruncated }),
      creatorPid: numberValue(meta.creatorPid) ?? 0,
      ...(numberValue(meta.pid) === undefined ? {} : { pid: numberValue(meta.pid)! }),
    };
    const legacyStatus = normalizeStatus(
      await readJson(this.#storage, join(jobDir, 'status.json')),
      baseInfo,
    ) ?? {
      id,
      status: 'unknown' as const,
      startedAt,
      updatedAt: Date.now(),
      ...(baseInfo.pid === undefined ? {} : { pid: baseInfo.pid }),
      error: 'Missing status.json',
    };
    const info = mergeStatus(baseInfo, legacyStatus);
    await this.writeInfo(info);
    return jobFromInfo(info);
  }

  private async writeInfo(info: BackgroundBashInfo): Promise<void> {
    await writeJson(this.#storage, info.infoPath, info);
  }

  private async writeStatus(path: string, status: BackgroundBashStatusFile): Promise<void> {
    await writeJson(this.#storage, path, status);
  }
}

/** @internal Applies a runner's completion record to a job; undefined when it is not a terminal record of that job. */
export function completeJob(info: BackgroundBashInfo, completion: unknown): BackgroundBashJob | undefined {
  const status = normalizeStatus(completion, info);
  return status && isTerminalStatus(status.status) ? jobFromInfo(mergeStatus(info, status)) : undefined;
}

/** @internal */
export function serializeJobRecord(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function jobFromInfo(info: BackgroundBashInfo): BackgroundBashJob {
  const meta: BackgroundBashMeta = {
    id: info.id,
    command: info.command,
    cwd: info.cwd,
    jobDir: info.jobDir,
    logPath: info.logPath,
    infoPath: info.infoPath,
    completionPath: info.completionPath,
    commandPath: info.commandPath,
    runnerPath: info.runnerPath,
    shell: info.shell,
    shellArgs: info.shellArgs,
    startedAt: info.startedAt,
    creatorPid: info.creatorPid,
    ...(info.executionMode === undefined ? {} : { executionMode: info.executionMode }),
    ...(info.promotedAt === undefined ? {} : { promotedAt: info.promotedAt }),
    ...(info.outputTruncated === undefined ? {} : { outputTruncated: info.outputTruncated }),
    ...(info.foreground === undefined ? {} : { foreground: info.foreground }),
    ...(info.notice === undefined ? {} : { notice: info.notice }),
    ...(info.noticeSession === undefined ? {} : { noticeSession: info.noticeSession }),
    ...(info.pid === undefined ? {} : { pid: info.pid }),
    ...(info.processGroupId === undefined ? {} : { processGroupId: info.processGroupId }),
    ...(info.processToken === undefined ? {} : { processToken: info.processToken }),
  };
  const status: BackgroundBashStatusFile = {
    id: info.id,
    status: info.status,
    startedAt: info.startedAt,
    updatedAt: info.updatedAt,
    ...(info.pid === undefined ? {} : { pid: info.pid }),
    ...(info.exitCode === undefined ? {} : { exitCode: info.exitCode }),
    ...(info.signal === undefined ? {} : { signal: info.signal }),
    ...(info.completedAt === undefined ? {} : { completedAt: info.completedAt }),
    ...(info.error === undefined ? {} : { error: info.error }),
    ...(info.executionMode === undefined ? {} : { executionMode: info.executionMode }),
    ...(info.promotedAt === undefined ? {} : { promotedAt: info.promotedAt }),
    ...(info.outputTruncated === undefined ? {} : { outputTruncated: info.outputTruncated }),
  };
  return { info, meta, status };
}

function mergeStatus(info: BackgroundBashInfo, status: BackgroundBashStatusFile): BackgroundBashInfo {
  return {
    ...info,
    status: status.status,
    updatedAt: status.updatedAt,
    ...(status.pid === undefined ? {} : { pid: status.pid }),
    ...(status.exitCode === undefined ? {} : { exitCode: status.exitCode }),
    ...(status.signal === undefined ? {} : { signal: status.signal }),
    ...(status.completedAt === undefined ? {} : { completedAt: status.completedAt }),
    ...(status.error === undefined ? {} : { error: status.error }),
    ...(status.executionMode === undefined ? {} : { executionMode: status.executionMode }),
    ...(status.promotedAt === undefined ? {} : { promotedAt: status.promotedAt }),
    ...(status.outputTruncated === undefined ? {} : { outputTruncated: status.outputTruncated }),
  };
}

function normalizeInfo(value: unknown, id: string, jobDir: string): BackgroundBashInfo | undefined {
  if (!isRecord(value) || value.id !== id || typeof value.command !== 'string') return undefined;
  const status = statusValue(value.status);
  const startedAt = numberValue(value.startedAt);
  if (!status || startedAt === undefined) return undefined;

  return {
    id,
    command: value.command,
    cwd: typeof value.cwd === 'string' ? value.cwd : '',
    jobDir,
    logPath: join(jobDir, 'output.log'),
    infoPath: join(jobDir, 'info.json'),
    completionPath: join(jobDir, 'completion.json'),
    commandPath: join(jobDir, 'command.sh'),
    runnerPath: join(jobDir, 'runner.sh'),
    shell: typeof value.shell === 'string' ? value.shell : 'sh',
    shellArgs: stringArray(value.shellArgs),
    startedAt,
    updatedAt: numberValue(value.updatedAt) ?? startedAt,
    status,
    creatorPid: numberValue(value.creatorPid) ?? 0,
    ...(numberValue(value.pid) === undefined ? {} : { pid: numberValue(value.pid)! }),
    ...(processGroupId(value) === undefined ? {} : { processGroupId: processGroupId(value)! }),
    ...(processToken(value.processToken) === undefined ? {} : { processToken: processToken(value.processToken)! }),
    ...(nullableNumber(value.exitCode) === undefined ? {} : { exitCode: nullableNumber(value.exitCode)! }),
    ...(nullableString(value.signal) === undefined ? {} : { signal: nullableString(value.signal)! }),
    ...(numberValue(value.completedAt) === undefined ? {} : { completedAt: numberValue(value.completedAt)! }),
    ...(typeof value.error !== 'string' ? {} : { error: value.error }),
    executionMode: executionMode(value.executionMode),
    ...(numberValue(value.promotedAt) === undefined ? {} : { promotedAt: numberValue(value.promotedAt)! }),
    ...(typeof value.outputTruncated !== 'boolean' ? {} : { outputTruncated: value.outputTruncated }),
    ...(typeof value.foreground === 'string' && value.foreground ? { foreground: value.foreground } : {}),
    ...(value.notice === 'pending' || value.notice === 'delivered' ? { notice: value.notice } : {}),
    ...(typeof value.noticeSession === 'string' && value.noticeSession ? { noticeSession: value.noticeSession } : {}),
  };
}

function normalizeStatus(
  value: unknown,
  info: BackgroundBashInfo,
): BackgroundBashStatusFile | undefined {
  if (!isRecord(value) || value.id !== info.id) return undefined;
  const status = statusValue(value.status);
  if (!status) return undefined;
  return {
    id: info.id,
    status,
    startedAt: numberValue(value.startedAt) ?? info.startedAt,
    updatedAt: numberValue(value.updatedAt) ?? info.updatedAt,
    ...(numberValue(value.pid) === undefined ? {} : { pid: numberValue(value.pid)! }),
    ...(nullableNumber(value.exitCode) === undefined ? {} : { exitCode: nullableNumber(value.exitCode)! }),
    ...(nullableString(value.signal) === undefined ? {} : { signal: nullableString(value.signal)! }),
    ...(numberValue(value.completedAt) === undefined ? {} : { completedAt: numberValue(value.completedAt)! }),
    ...(typeof value.error !== 'string' ? {} : { error: value.error }),
    ...(value.executionMode === undefined ? {} : { executionMode: executionMode(value.executionMode) }),
    ...(numberValue(value.promotedAt) === undefined ? {} : { promotedAt: numberValue(value.promotedAt)! }),
    ...(typeof value.outputTruncated !== 'boolean' ? {} : { outputTruncated: value.outputTruncated }),
  };
}

async function readJson(storage: AgentRuntimeStorage, path: string): Promise<unknown> {
  try {
    return JSON.parse(decoder.decode(await storage.readFile(path)));
  } catch {
    return undefined;
  }
}

async function writeJson(storage: AgentRuntimeStorage, path: string, value: unknown): Promise<void> {
  await storage.writeFile(path, encoder.encode(serializeJobRecord(value)));
}

function statusValue(value: unknown): BackgroundBashStatus | undefined {
  return typeof value === 'string' && STATUS_VALUES.has(value)
    ? value as BackgroundBashStatus
    : undefined;
}

function executionMode(value: unknown): 'detached' | 'pty' | 'attached' {
  return value === 'pty' || value === 'attached' ? value : 'detached';
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nullableNumber(value: unknown): number | null | undefined {
  return value === null ? null : numberValue(value);
}

function nullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === 'string' ? value : undefined;
}

function processGroupId(value: Record<string, unknown>): number | undefined {
  const explicit = numberValue(value.processGroupId);
  if (explicit !== undefined) return explicit;
  const pid = numberValue(value.pid);
  return value.processGroup === true ? pid : undefined;
}

function processToken(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{32}$/u.test(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error
    && (('code' in error && error.code === 'EEXIST') || error.message.includes('already exists'));
}
