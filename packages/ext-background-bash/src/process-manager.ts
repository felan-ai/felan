import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { AgentRuntime, AgentRuntimeStorage } from '@felan-ai/agent-core';
import { BackgroundBashCoordinator, type InteractiveBashProcess } from './coordinator.js';
import { shellQuote } from './runtime-support.js';
import { createOutputLog, readLogTail } from './logs.js';
import {
  BackgroundBashJobStore,
  completeJob,
  jobFromInfo,
  serializeJobRecord,
  type BackgroundBashInfo,
  type BackgroundBashJob,
  type BackgroundBashPage,
  type BackgroundBashQuery,
  type BackgroundBashStatusFilter,
  isBackgroundBashJobId,
  isTerminalStatus,
} from './job-store.js';

/** A finished foreground job, with its output when the wait call returned it. */
export interface ForegroundExit {
  job: BackgroundBashJob;
  /** The whole log, when it was small enough to return; `removed` means the wait call also deleted the job. */
  output?: { content: Uint8Array; removed: boolean };
}

export interface WaitBackgroundBashResult {
  job: BackgroundBashJob;
  timedOut: boolean;
}

const WAIT_POLL_MS = 500;
/** Remote shell calls have time limits, so a foreground wait blocks in slices of at most this long. */
const FOREGROUND_WAIT_SLICE_MS = 25_000;
const FOREGROUND_MAX_FAILED_WAITS = 10;
const FOREGROUND_DEAD_RECHECK_MS = 500;
const FOREGROUND_SHORT_POLLS = 20;
const FOREGROUND_PROBE_POLLS = 64;
/** A log this small cannot exceed the result limits even if every byte decodes to a three-byte replacement character. */
const FOREGROUND_INLINE_LOG_BYTES = 16 * 1024;
const FOREGROUND_INLINE_LOG_LINES = 2_000;
const FOREGROUND_WAIT_OUTPUT_BYTES = 256 * 1024;
/** Linux limits one argv string to 128 KiB; a larger launch script falls back to storage writes. */
const ONE_CALL_LAUNCH_MAX_BYTES = 64 * 1024;
const LAUNCH_ID_TAKEN_EXIT = 17;
const LAUNCH_UNSUPPORTED_EXIT = 64;
const PROCESS_STATUS_GRACE_MS = 5_000;
const STOP_PROCESS_WAIT_MS = 5_000;
const RUNNER_MARKER_MAX_AGE_SECONDS = 3;
const UNATTACHED_PROCESS_ERROR = 'Process is not attached to a live root session; its exit status is unavailable.';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const pendingLaunches = new Map<string, Promise<void>>();
/** Marks foreground jobs this process waits on; a job marked by another process lost its waiter to a restart. */
const PROCESS_INSTANCE = randomBytes(16).toString('hex');

export class BackgroundBashManager {
  readonly #store: BackgroundBashJobStore;
  readonly #storage: AgentRuntimeStorage;

  readonly #coordinator: BackgroundBashCoordinator;
  /** The host runtime of a Windows host runs POSIX calls through Git Bash. */
  readonly #gitBashHost: boolean;

  constructor(private readonly runtime: AgentRuntime) {
    this.#gitBashHost = process.platform === 'win32' && runtime.kind === 'host';
    this.#storage = runtime.storage('session');
    this.#store = new BackgroundBashJobStore(runtime, this.#storage);
    this.#coordinator = new BackgroundBashCoordinator(runtime, snapshot => this.#persistInteractiveSnapshot(snapshot.id, snapshot));
  }

  async startInteractive(command: string): Promise<{ job: BackgroundBashJob; process: InteractiveBashProcess }> {
    const job = await this.#store.createJob(command, 'pty');
    const finishLaunch = trackLaunch(job.meta.jobDir);
    try {
      await createOutputLog(this.#storage, job.meta.logPath);
      await this.#storage.writeFile(job.meta.commandPath, encoder.encode(`${command}\n`));
      const process = await this.#coordinator.start(
        job.meta.id,
        command,
        this.runtime.cwd,
      );
      const updated = await this.#store.updatePid(job.meta.id, process.pid ?? 0, undefined, {
        executionMode: 'pty',
      });
      if (!updated) throw new Error(`Background process disappeared during startup: ${job.meta.id}`);
      return { job: updated, process };
    } catch (error) {
      if (this.#coordinator.has(job.meta.id)) {
        try {
          await this.#coordinator.stop(job.meta.id, 'SIGKILL');
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], `Failed to clean up interactive startup ${job.meta.id}`);
        }
      }
      await this.#store.markStatus(job.meta.id, {
        status: 'failed',
        exitCode: null,
        signal: null,
        error: errorMessage(error),
      });
      throw error;
    } finally {
      finishLaunch();
    }
  }

  async readInteractive(id: string, waitMs = 0, signal?: AbortSignal): Promise<InteractiveBashProcess> {
    return this.#coordinator.read(id, waitMs, signal);
  }

  async writeInteractive(id: string, chars: string): Promise<InteractiveBashProcess> {
    return this.#coordinator.write(id, chars);
  }

  async stopInteractive(id: string, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<InteractiveBashProcess> {
    return this.#coordinator.stop(id, signal);
  }

  async shutdownInteractive(): Promise<void> {
    await this.#coordinator.shutdown();
  }

  async markPromoted(id: string, executionMode: 'detached' | 'pty' = 'detached'): Promise<BackgroundBashJob | undefined> {
    return this.#store.markRunning(id, executionMode, Date.now());
  }

  /**
   * Starts a detached job that a foreground tool call waits on; it stays unlisted until promoted. One shell call
   * writes the job directory and launches the runner, because each runtime call is a round trip on remote runtimes.
   */
  async startForeground(command: string, noticeSession: string): Promise<BackgroundBashJob> {
    const options = { foreground: PROCESS_INSTANCE, noticeSession };
    // A launch script of this size reaches Git Bash cut short, so a Windows host writes the job through storage.
    if (this.#gitBashHost) return this.start(command, options);
    for (let attempt = 0; ; attempt += 1) {
      const info = this.#store.prepareJob(command, options);
      const script = createOneCallLaunchScript(info, this.#store.jobsDir, this.#store.noticesDir);
      if (command.includes('\0') || encoder.encode(script).byteLength > ONE_CALL_LAUNCH_MAX_BYTES) return this.start(command, options);
      const job = jobFromInfo(info);
      const finishLaunch = trackLaunch(info.jobDir);
      let launchedProcess: ReturnType<typeof parseLaunchResult>;
      let retry: 'storage' | 'new-id' | undefined;
      try {
        const launch = await this.runtime.shell(script, { cwd: this.runtime.cwd, shellFlavor: 'posix', timeout: 10_000 });
        launchedProcess = launch.killed ? undefined : parseLaunchResult(launch.stdout);
        // Both codes exit before anything is written.
        if (!launchedProcess && !launch.killed && launch.code === LAUNCH_UNSUPPORTED_EXIT) retry = 'storage';
        else if (!launchedProcess && !launch.killed && launch.code === LAUNCH_ID_TAKEN_EXIT && attempt < 4) retry = 'new-id';
        else {
          if (launch.killed || launch.code !== 0) throw new Error(launch.stderr || launch.stdout || 'Background runner failed to launch');
          if (!launchedProcess) throw new Error('Background runner did not report a process id');
          await this.#store.recordCreated();
          return jobFromInfo({ ...info, pid: launchedProcess.pid, processGroupId: launchedProcess.processGroupId ?? launchedProcess.pid });
        }
      } catch (error) {
        return await this.#failStart(job, launchedProcess, error);
      } finally {
        finishLaunch();
      }
      if (retry === 'storage') return this.start(command, options);
    }
  }

  /** A foreground job whose waiting tool call ended with an earlier process. */
  isForegroundOrphan(job: BackgroundBashJob): boolean {
    return job.meta.foreground !== undefined && job.meta.foreground !== PROCESS_INSTANCE;
  }

  /**
   * Waits inside the runtime for a foreground job to finish, in bounded slices; resolves undefined at the deadline.
   * The call that sees the job finish also returns a small log and deletes the job when no result can need it.
   */
  async waitForForeground(job: BackgroundBashJob, deadline: number, signal?: AbortSignal): Promise<ForegroundExit | undefined> {
    if (this.#gitBashHost) return this.#pollForeground(job, deadline, signal);
    const id = job.meta.id;
    let failures = 0;
    let lastFailure: unknown;
    while (true) {
      signal?.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      const sliceMs = Math.min(remaining, FOREGROUND_WAIT_SLICE_MS);
      const boundary = randomBytes(16).toString('hex');
      const slice = new AbortController();
      const abortSlice = () => slice.abort();
      signal?.addEventListener('abort', abortSlice, { once: true });
      const timer = setTimeout(abortSlice, sliceMs);
      let result: Awaited<ReturnType<AgentRuntime['shell']>> | undefined;
      try {
        result = await this.runtime.shell(createForegroundWaitScript(job, this.#store.noticesDir, boundary, Math.ceil(sliceMs / 1_000) + 1), {
          cwd: this.runtime.cwd,
          shellFlavor: 'posix',
          signal: slice.signal,
          timeout: sliceMs + 10_000,
          maxOutputBytes: FOREGROUND_WAIT_OUTPUT_BYTES,
        });
      } catch (error) {
        lastFailure = error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortSlice);
      }
      signal?.throwIfAborted();
      const parsed = result && !result.truncated && (result.killed || result.code === 0)
        ? parseForegroundWait(result.stdout, boundary)
        : undefined;
      if (parsed?.state === 'done') {
        const finished = completeJob(job.info, parsed.completion);
        if (finished && parsed.final) return parsed.output ? { job: finished, output: parsed.output } : { job: finished };
        // A slice ended at the deadline after printing the whole log may already have deleted the job.
        if (finished && parsed.output && !await this.#store.readJob(id)) {
          return { job: finished, output: { content: parsed.output.content, removed: true } };
        }
      }
      if (slice.signal.aborted) continue;
      if (parsed?.state === 'running') {
        failures = 0;
        continue;
      }
      if (parsed?.state === 'gone') throw new Error(`Background process not found: ${id}`);
      if (parsed?.state === 'dead' || parsed?.state === 'done') {
        // The runner is gone without a readable completion record; the store's normal refresh decides its status.
        const latest = await this.get(id);
        if (isTerminalStatus(latest.status.status)) return { job: latest };
        failures = 0;
        await sleep(Math.max(0, Math.min(FOREGROUND_DEAD_RECHECK_MS, deadline - Date.now())), signal);
        continue;
      }
      // A remote shell call can fail transiently; only repeated failures end the wait.
      if (result) lastFailure = new Error(result.stderr || result.stdout || `Waiting for ${id} failed (exit ${result.code})`);
      if (++failures >= FOREGROUND_MAX_FAILED_WAITS) throw new Error(`Unable to wait for background process ${id}`, { cause: lastFailure });
      await sleep(Math.max(0, Math.min(100 * failures, deadline - Date.now())), signal);
    }
  }

  /**
   * A Windows host polls the job through storage reads. Ending Git Bash's in-runtime wait loop at the deadline means
   * killing its process tree, which does not end that shell call promptly.
   */
  async #pollForeground(job: BackgroundBashJob, deadline: number, signal?: AbortSignal): Promise<ForegroundExit | undefined> {
    const id = job.meta.id;
    const pid = job.meta.pid ?? job.status.pid;
    let misses = 0;
    for (let polls = 1; ; polls += 1) {
      signal?.throwIfAborted();
      const latest = await this.#store.readJob(id);
      if (!latest) {
        // A record that another process is rewriting reads as missing for a moment.
        if (++misses >= FOREGROUND_MAX_FAILED_WAITS) throw new Error(`Background process not found: ${id}`);
      } else {
        misses = 0;
        if (isTerminalStatus(latest.status.status)) return { job: latest };
        // As in the in-runtime wait, only a runner that `kill -0` no longer finds goes through the store's refresh.
        if (polls % FOREGROUND_PROBE_POLLS === 0 && pid !== undefined && !await this.#isProcessAlive(pid)) {
          const refreshed = await this.get(id);
          if (isTerminalStatus(refreshed.status.status)) return { job: refreshed };
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      await sleep(Math.min(remaining, polls <= FOREGROUND_SHORT_POLLS ? 10 : 30), signal);
    }
  }

  async removeJob(id: string): Promise<void> {
    await this.#store.removeJob(id);
  }

  async settleNotice(id: string, session: string): Promise<boolean> {
    return this.#store.settleNotice(id, session);
  }

  async pendingNotices(session?: string): Promise<BackgroundBashJob[]> {
    return this.#store.pendingNotices(session);
  }

  async start(command: string, options?: { foreground?: string; noticeSession?: string }): Promise<BackgroundBashJob> {
    const job = await this.#store.createJob(command, 'detached', options);
    const finishLaunch = trackLaunch(job.meta.jobDir);
    let launchedProcess: ReturnType<typeof parseLaunchResult>;
    try {
      await createOutputLog(this.#storage, job.meta.logPath);
      await this.#storage.writeFile(job.meta.commandPath, encoder.encode(`${command}\n`));
      await this.#storage.writeFile(job.meta.runnerPath, encoder.encode(createRunnerScript(job)));
      const launch = await this.runtime.shell(createLaunchCommand(
        job.meta.runnerPath,
        job.meta.processToken!,
      ), {
        cwd: this.runtime.cwd,
        shellFlavor: 'posix',
        timeout: 10_000,
      });
      if (launch.killed || launch.code !== 0) {
        throw new Error(launch.stderr || launch.stdout || 'Background runner failed to launch');
      }
      launchedProcess = parseLaunchResult(launch.stdout);
      if (!launchedProcess) throw new Error('Background runner did not report a process id');
      const updated = await this.#store.updatePid(
        job.meta.id,
        launchedProcess.pid,
        launchedProcess.processGroupId,
      );
      if (!updated) throw new Error(`Background process disappeared during startup: ${job.meta.id}`);
      return updated;
    } catch (error) {
      return await this.#failStart(job, launchedProcess, error);
    } finally {
      finishLaunch();
    }
  }

  /** Stops a runner whose startup failed and records the job as failed. */
  async #failStart(
    job: BackgroundBashJob,
    launchedProcess: { pid: number; processGroupId?: number } | undefined,
    error: unknown,
  ): Promise<never> {
    if (launchedProcess) {
      try {
        await this.#stopUnregisteredProcess(job, launchedProcess.pid);
      } catch (cleanupError) {
        const errors: unknown[] = [error, cleanupError];
        try {
          await this.#store.updatePid(job.meta.id, launchedProcess.pid, launchedProcess.processGroupId);
        } catch (persistenceError) {
          errors.push(persistenceError);
        }
        throw new AggregateError(errors, `Failed to clean up background startup ${job.meta.id} (PID ${launchedProcess.pid})`);
      }
    }
    await this.#store.markStatus(job.meta.id, {
      status: 'failed',
      ...(launchedProcess === undefined ? {} : { pid: launchedProcess.pid }),
      exitCode: null,
      signal: null,
      error: errorMessage(error),
    });
    throw new Error(`Failed to start background bash process: ${errorMessage(error)}`, { cause: error });
  }

  async list(status: BackgroundBashStatusFilter = 'all'): Promise<BackgroundBashJob[]> {
    const jobs = await this.#store.listJobs('all');
    const normalized: BackgroundBashJob[] = [];
    for (const job of jobs) {
      normalized.push(await this.#refreshJob(job));
    }
    const filtered = status === 'all'
      ? normalized
      : normalized.filter((job) => job.status.status === status);
    filtered.sort(compareJobsForList);
    return filtered;
  }

  async query(options: BackgroundBashQuery = {}): Promise<BackgroundBashPage> {
    return this.#store.query(options, job => this.#refreshJob(job));
  }

  async get(id: string): Promise<BackgroundBashJob> {
    const wasStarting = pendingLaunches.has(resolve(this.#store.jobsDir, id));
    const job = await this.#store.readJob(id);
    if (!job) throw new Error(`Background process not found: ${id}`);
    if (wasStarting) return job;
    return this.#refreshJob(job);
  }

  /** Reads a job and reports whether its runner is alive and passes the identity check a stop makes before it signals. */
  async inspect(id: string): Promise<{ job: BackgroundBashJob; verified: boolean }> {
    const stored = await this.#store.readJob(id);
    if (!stored) throw new Error(`Background process not found: ${id}`);
    const pid = stored.status.pid ?? stored.meta.pid;
    if (stored.status.status === 'running' && stored.meta.executionMode === 'detached' && pid !== undefined
      && !pendingLaunches.has(resolve(stored.meta.jobDir)) && await this.#isJobProcessAlive(stored, pid)) {
      return { job: stored, verified: true };
    }
    return { job: await this.get(id), verified: false };
  }

  async #refreshJob(job: BackgroundBashJob): Promise<BackgroundBashJob> {
    const id = job.meta.id;
    const key = resolve(job.meta.jobDir);
    if (pendingLaunches.has(key) || this.#coordinator.isStarting(id)) return job;
    if (job.meta.executionMode === 'attached') return this.#normalizeJob(job);
    if (this.#coordinator.has(id)) {
      await this.readInteractive(id);
      const refreshed = await this.#store.readJob(id);
      if (refreshed) return refreshed;
    }
    return this.#normalizeJob(job);
  }

  async wait(
    id: string,
    timeoutSeconds?: number,
    signal?: AbortSignal,
  ): Promise<WaitBackgroundBashResult> {
    const deadline = timeoutSeconds === undefined
      ? undefined
      : Date.now() + Math.max(0, timeoutSeconds) * 1_000;

    while (true) {
      signal?.throwIfAborted();
      const job = await this.get(id);
      if (isTerminalStatus(job.status.status)) return { job, timedOut: false };
      if (deadline !== undefined && Date.now() >= deadline) return { job, timedOut: true };

      const delay = deadline === undefined
        ? WAIT_POLL_MS
        : Math.max(0, Math.min(WAIT_POLL_MS, deadline - Date.now()));
      await sleep(delay, signal);
    }
  }

  async stop(id: string, signal: NodeJS.Signals = 'SIGTERM'): Promise<BackgroundBashJob> {
    if (!isBackgroundBashJobId(id)) throw new Error(`Background process not found: ${id}`);
    const key = resolve(this.#store.jobsDir, id);
    await pendingLaunches.get(key);
    const stored = await this.#store.readJob(id);
    if (!stored) throw new Error(`Background process not found: ${id}`);
    if (stored.meta.executionMode === 'attached') {
      return await this.#store.markStatus(id, {
        status: 'unknown', exitCode: null, signal: null, error: UNATTACHED_PROCESS_ERROR,
      }) ?? stored;
    }
    if (this.#coordinator.has(id)) {
      try {
        await this.stopInteractive(id, signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM');
      } catch (error) {
        if (!this.#coordinator.has(id)) {
          const latest = await this.#store.readJob(id);
          if (latest && isTerminalStatus(latest.status.status)) return latest;
        }
        throw error;
      }
      const interactive = await this.#store.readJob(id);
      if (interactive) return interactive;
    }
    let job = await this.get(id);
    if (isTerminalStatus(job.status.status)) return job;

    const pid = job.status.pid ?? job.meta.pid;
    const inspection = pid
      ? await this.#inspectForStop(job, pid)
      : { job, inspected: undefined };
    job = inspection.job;
    if (isTerminalStatus(job.status.status)) return job;
    const inspected = inspection.inspected;
    if (!pid || !inspected) {
      const latest = await this.#store.readJob(id);
      if (latest && isTerminalStatus(latest.status.status)) return latest;
      const unknown = await this.#store.markStatus(id, {
        status: 'unknown',
        ...(pid === undefined ? {} : { pid }),
        exitCode: null,
        signal: null,
        error: pid ? 'Process is no longer alive.' : 'No process id was recorded.',
      });
      if (!unknown) throw new Error(`Background process not found: ${id}`);
      return unknown;
    }

    let result = inspected?.processGroupId === pid
      ? await this.#sendSignal(-inspected.processGroupId, signal)
      : await this.#sendSignal(pid, signal);
    if (result.code !== 0 && inspected?.processGroupId === pid) {
      result = await this.#sendSignal(pid, signal);
    }
    if (result.code !== 0) {
      throw new Error(result.stderr || `Unable to send ${signal} to background process ${id}`);
    }

    if (!await this.#waitForProcessExit(pid)) {
      throw new Error(`Background process ${id} did not exit after ${STOP_PROCESS_WAIT_MS / 1_000} seconds; it is still running.`);
    }

    const completed = await this.#store.readJob(id);
    if (completed && isTerminalStatus(completed.status.status)) return completed;
    const killed = await this.#store.markStatus(id, {
      status: 'killed',
      pid,
      exitCode: null,
      signal,
    });
    if (!killed) throw new Error(`Background process not found: ${id}`);
    return killed;
  }

  async tail(id: string, lines = 80): Promise<string> {
    const job = await this.get(id);
    return readLogTail(this.runtime, this.#storage, job.meta.logPath, lines);
  }

  async #persistInteractiveSnapshot(id: string, snapshot: InteractiveBashProcess): Promise<void> {
    const job = await this.#store.readJob(id);
    if (!job) throw new Error(`Background process not found: ${id}`);
    await this.#storage.writeFile(job.meta.logPath, encoder.encode(snapshot.output));
    if (snapshot.running) return;
    await this.#store.markStatus(id, snapshot.signal
      ? { status: 'killed', exitCode: null, signal: snapshot.signal }
      : snapshot.exitCode === undefined
        ? { status: 'unknown', exitCode: null, error: 'Interactive process exited without reporting an exit code.' }
        : { status: snapshot.exitCode === 0 ? 'completed' : 'failed', exitCode: snapshot.exitCode });
  }

  async #stopUnregisteredProcess(job: BackgroundBashJob, pid: number): Promise<void> {
    const deadline = Date.now() + PROCESS_STATUS_GRACE_MS;
    let inspected = await this.#inspectJobProcess(job, pid);
    while (!inspected) {
      if (!await this.#isProcessAlive(pid)) return;
      if (Date.now() >= deadline) throw new Error(`Unable to verify background startup ${job.meta.id} (PID ${pid})`);
      await sleep(50);
      inspected = await this.#inspectJobProcess(job, pid);
    }
    const result = await this.#sendSignal(inspected.processGroupId === pid ? -pid : pid, 'SIGKILL');
    if (result.code !== 0 && await this.#isProcessAlive(pid)) {
      throw new Error(result.stderr || `Unable to stop background startup ${job.meta.id}`);
    }
    if (!await this.#waitForProcessExit(pid)) {
      throw new Error(`Background startup process ${job.meta.id} (PID ${pid}) did not exit`);
    }
  }

  async #normalizeJob(job: BackgroundBashJob): Promise<BackgroundBashJob> {
    if (job.status.status !== 'running') return job;

    if (job.meta.executionMode === 'attached') {
      if (Date.now() - (job.meta.promotedAt ?? job.meta.startedAt) <= PROCESS_STATUS_GRACE_MS) return job;
      return await this.#store.markStatus(job.meta.id, {
        status: 'unknown', exitCode: null, signal: null, error: UNATTACHED_PROCESS_ERROR,
      }) ?? job;
    }
    const pid = job.status.pid ?? job.meta.pid;
    const now = Date.now();
    if (now - job.status.startedAt <= PROCESS_STATUS_GRACE_MS) return job;
    if (job.meta.executionMode === 'pty') {
      return await this.#store.markStatus(job.meta.id, {
        status: 'unknown',
        exitCode: null,
        signal: null,
        error: 'Interactive process is not attached to this root session; its exit status is unavailable.',
      }) ?? job;
    }
    if (pid && await this.#isJobProcessAlive(job, pid)) return job;

    const latest = await this.#store.readJob(job.meta.id);
    if (latest && isTerminalStatus(latest.status.status)) return latest;
    return await this.#store.markStatus(job.meta.id, {
      status: 'unknown',
      ...(pid === undefined ? {} : { pid }),
      exitCode: null,
      signal: null,
      error: pid
        ? 'Process is no longer alive and no terminal status was written.'
        : 'No process id was recorded and no terminal status was written.',
    }) ?? job;
  }

  async #isJobProcessAlive(job: BackgroundBashJob, pid: number): Promise<boolean> {
    return await this.#inspectJobProcess(job, pid) !== undefined;
  }

  async #inspectForStop(
    job: BackgroundBashJob,
    pid: number,
  ): Promise<{ job: BackgroundBashJob; inspected?: { processGroupId: number } }> {
    let latest = job;
    const deadline = Date.now() + PROCESS_STATUS_GRACE_MS;
    while (true) {
      latest = await this.#store.readJob(job.meta.id) ?? latest;
      if (isTerminalStatus(latest.status.status)) return { job: latest };
      const inspected = await this.#inspectJobProcess(latest, pid);
      if (inspected) return { job: latest, inspected };
      if (Date.now() >= deadline) return { job: latest };
      await sleep(50);
    }
  }

  async #waitForProcessExit(pid: number): Promise<boolean> {
    const deadline = Date.now() + STOP_PROCESS_WAIT_MS;
    while (Date.now() < deadline) {
      if (!await this.#isProcessAlive(pid)) return true;
      await sleep(Math.min(50, deadline - Date.now()));
    }
    return !await this.#isProcessAlive(pid);
  }

  async #isProcessAlive(pid: number): Promise<boolean> {
    const result = await this.runtime.shell(`kill -0 ${shellQuote(String(pid))} 2>/dev/null`, {
      cwd: this.runtime.cwd,
      shellFlavor: 'posix',
    });
    return result.code === 0;
  }

  async #inspectJobProcess(
    job: BackgroundBashJob,
    pid: number,
  ): Promise<{ processGroupId: number } | undefined> {
    const result = await this.runtime.shell(createInspectCommand(pid), {
      cwd: this.runtime.cwd,
      shellFlavor: 'posix',
    });
    if (result.code !== 0) return undefined;
    const inspected = parseProcessInspection(result.stdout);
    if (!inspected) return undefined;
    const { processGroupId, command } = inspected;
    const expectedProcessGroupId = job.meta.processGroupId ?? pid;
    const isGitBashShell = /(?:^|\/)(?:sh|bash)(?:\.exe)?$/iu.test(command);
    const markerMatches = isGitBashShell && await this.#runnerMarkerMatches(job, pid);
    const matchesGitBashProcess = isGitBashShell
      && processGroupId === expectedProcessGroupId
      && processGroupId === pid
      && markerMatches;
    if (job.meta.processToken) {
      if (
        (!containsPosixPath(command, job.meta.runnerPath) || !command.includes(job.meta.processToken))
        && !matchesGitBashProcess
      ) return undefined;
    } else if (
      !containsPosixPath(command, job.meta.runnerPath)
      && !matchesGitBashProcess
      && !(command.includes('PI_BG_INFO_PATH') && command.includes('PI_BG_COMMAND'))
    ) {
      return undefined;
    }
    return { processGroupId };
  }

  async #runnerMarkerMatches(job: BackgroundBashJob, pid: number): Promise<boolean> {
    if (!job.meta.processToken) return false;
    try {
      const markerPath = join(job.meta.jobDir, 'runner-heartbeat');
      const [id, token, markerPid, timestamp] = decoder
        .decode(await this.#storage.readFile(markerPath))
        .trim()
        .split(/\r?\n/u);
      const markerTimestamp = Number(timestamp);
      return id === job.meta.id
        && token === job.meta.processToken
        && markerPid === String(pid)
        && Number.isSafeInteger(markerTimestamp)
        && Math.abs(Math.floor(Date.now() / 1_000) - markerTimestamp) <= RUNNER_MARKER_MAX_AGE_SECONDS;
    } catch {
      return false;
    }
  }

  #sendSignal(pid: number, signal: NodeJS.Signals) {
    const target = pid < 0 ? String(pid) : shellQuote(String(pid));
    return this.runtime.shell(`kill -${signal.slice(3)} ${target}`, {
      cwd: this.runtime.cwd,
      shellFlavor: 'posix',
    });
  }
}

function createLaunchCommand(runnerPath: string, processToken: string): string {
  const path = shellQuote(runnerPath);
  const token = shellQuote(processToken);
  return [
    'if command -v setsid >/dev/null 2>&1; then',
    `  nohup setsid sh ${path} ${token} >/dev/null 2>&1 < /dev/null &`,
    '  pid="$!"',
    '  process_group="$pid"',
    "  printf 'group:%s:%s\\n' \"$pid\" \"$pid\"",
    'else',
    '  set -m 2>/dev/null || true',
    `  nohup sh ${path} ${token} >/dev/null 2>&1 < /dev/null &`,
    '  pid="$!"',
    "  process_group=$(ps -o pgid= -p \"$pid\" 2>/dev/null | tr -d ' ')",
    '  if [ -z "$process_group" ]; then',
    '    process_group=$(ps -l -p "$pid" 2>/dev/null | {',
    '      IFS= read -r header',
    '      IFS= read -r row',
    '      set -- $row',
    '      printf "%s\\n" "${3:-}"',
    '    })',
    '  fi',
    '  if [ "$process_group" = "$pid" ]; then',
    "    printf 'group:%s:%s\\n' \"$pid\" \"$process_group\"",
    '  else',
    '    kill "$pid" 2>/dev/null',
    '    wait "$pid" 2>/dev/null',
    "    printf '%s\\n' 'Unable to create a detached process group' >&2",
    '    exit 1',
    '  fi',
    'fi',
  ].join('\n');
}

/** Shell text for an exact string; unlike `shellQuote`, it never rewrites backslashes, so file contents stay intact. */
function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Writes a new job's directory and launches its runner in one shell call. The record is written before the launch, so
 * a failed launch can still be recorded, and rewritten with the runner's process id afterwards.
 */
function createOneCallLaunchScript(info: BackgroundBashInfo, jobsDir: string, noticesDir: string): string {
  const job = jobFromInfo(info);
  const withProcess = serializeJobRecord({ ...info, pid: 0, processGroupId: 0 });
  const processFields = '"pid": 0,\n  "processGroupId": 0\n}\n';
  if (!withProcess.endsWith(processFields)) throw new Error('Unexpected background job record layout');
  const recordPrefix = `${withProcess.slice(0, -processFields.length)}"pid": `;
  const infoPath = shellQuote(info.infoPath);
  const jobDir = shellQuote(info.jobDir);
  return [
    `command -v mkdir >/dev/null 2>&1 || exit ${LAUNCH_UNSUPPORTED_EXIT}`,
    `mkdir -p ${shellQuote(jobsDir)} || exit 1`,
    `mkdir ${jobDir} 2>/dev/null || { [ -e ${jobDir} ] && exit ${LAUNCH_ID_TAKEN_EXIT}; mkdir ${jobDir} || exit 1; }`,
    ...(info.notice === 'pending'
      ? [`mkdir -p ${shellQuote(noticesDir)} && : > ${shellQuote(join(noticesDir, info.id))} || exit 1`]
      : []),
    `printf '%s' ${shellLiteral(serializeJobRecord(info))} > ${infoPath} || exit 1`,
    `: > ${shellQuote(info.logPath)} || exit 1`,
    `printf '%s\\n' ${shellLiteral(info.command)} > ${shellQuote(info.commandPath)} || exit 1`,
    `printf '%s' ${shellLiteral(createRunnerScript(job))} > ${shellQuote(info.runnerPath)} || exit 1`,
    createLaunchCommand(info.runnerPath, info.processToken!),
    `record_tmp=${shellQuote(`${info.infoPath}.launch.tmp`)}`,
    `printf '%s%s%s%s%s' ${shellLiteral(recordPrefix)} "$pid" ${shellLiteral(',\n  "processGroupId": ')} "$process_group" ${shellLiteral('\n}\n')} > "$record_tmp" \\`,
    `  && mv "$record_tmp" ${infoPath}`,
  ].join('\n');
}

/**
 * Blocks inside the runtime until the job's completion record appears, its directory disappears, its runner dies, or
 * the slice ends. It checks every 10 ms for the first 0.2 s, then every 30 ms, and probes the runner every 64 checks.
 * A finished job's whole log is returned when it is small, and the job is deleted when no result can need it. Builtins
 * replace utilities where they can, because each spawned process adds latency after the command exits.
 */
function createForegroundWaitScript(job: BackgroundBashJob, noticesDir: string, boundary: string, sliceSeconds: number): string {
  const pid = job.meta.pid ?? job.status.pid;
  const jobDir = shellQuote(job.meta.jobDir);
  const completion = shellQuote(job.meta.completionPath);
  const output = shellQuote(job.meta.logPath);
  const shortPolls = FOREGROUND_SHORT_POLLS;
  const maxPolls = shortPolls + Math.ceil((sliceSeconds * 1_000 - shortPolls * 10) / 30);
  return [
    `short=0.01; long=0.03; every=${FOREGROUND_PROBE_POLLS}; polls=0`,
    `limit=${maxPolls}`,
    `while [ ! -f ${completion} ]; do`,
    `  if [ ! -d ${jobDir} ]; then printf 'gone\\n'; exit 0; fi`,
    '  polls=$((polls + 1))',
    "  if [ \"$polls\" -gt \"$limit\" ]; then printf 'running\\n'; exit 0; fi",
    ...(pid === undefined ? [] : [
      '  if [ $((polls % every)) -eq 0 ] && ! kill -0 ' + String(pid) + ' 2>/dev/null; then',
      `    [ -f ${completion} ] && break`,
      "    printf 'dead\\n'; exit 0",
      '  fi',
    ]),
    `  if [ "$polls" -le ${shortPolls} ]; then delay=$short; else delay=$long; fi`,
    // Without fractional sleep, poll each second and count each poll toward the slice as 30 ms would be.
    '  sleep "$delay" 2>/dev/null || { sleep 1; short=1; long=1; every=1; limit=$((polls + (limit - polls) * 3 / 100 + 1)); }',
    'done',
    "printf 'done\\n'",
    `while IFS= read -r line || [ -n "$line" ]; do printf '%s\\n' "$line"; done < ${completion}`,
    `printf '%s\\n' ${boundary}`,
    `if [ -f ${output} ] && ! tail -c +${FOREGROUND_INLINE_LOG_BYTES + 1} ${output} | LC_ALL=C tr -c x x | { IFS= read -r rest || [ -n "$rest" ]; }; then`,
    `  cat ${output} || exit 1`,
    '  newlines=0',
    `  while IFS= read -r line; do newlines=$((newlines + 1)); done < ${output}`,
    '  flag=kept',
    `  if [ "$newlines" -lt ${FOREGROUND_INLINE_LOG_LINES} ] && command -v rm >/dev/null 2>&1; then`,
    `    rm -rf ${jobDir} ${shellQuote(join(noticesDir, job.meta.id))} && flag=removed`,
    '  fi',
    'else',
    '  flag=large',
    'fi',
    `printf '\\n%s:%s\\n' ${boundary} "$flag"`,
  ].join('\n');
}

type ForegroundWaitOutput =
  | { state: 'running' | 'dead' | 'gone' }
  | { state: 'done'; completion: unknown; final: boolean; output?: { content: Uint8Array; removed: boolean } };

function parseForegroundWait(stdout: string, boundary: string): ForegroundWaitOutput | undefined {
  if (stdout === 'running\n' || stdout === 'dead\n' || stdout === 'gone\n') {
    return { state: stdout.slice(0, -1) as 'running' | 'dead' | 'gone' };
  }
  if (!stdout.startsWith('done\n')) return undefined;
  const separator = `\n${boundary}\n`;
  const recordEnd = stdout.indexOf(separator);
  if (recordEnd < 0) return undefined;
  let completion: unknown;
  try {
    completion = JSON.parse(stdout.slice('done\n'.length, recordEnd));
  } catch {
    completion = undefined;
  }
  // Without the final flag line the call was cut off; the text after the record is then at most the whole log.
  const flagMatch = stdout.match(new RegExp(`\\n${boundary}:(removed|kept|large)\\n$`, 'u'));
  const flag = flagMatch?.[1];
  if (flag === 'large') return { state: 'done', completion, final: true };
  const content = stdout.slice(recordEnd + separator.length, stdout.length - (flagMatch?.[0].length ?? 0));
  return { state: 'done', completion, final: flag !== undefined, output: { content: encoder.encode(content), removed: flag === 'removed' } };
}

function createInspectCommand(pid: number): string {
  const quotedPid = shellQuote(String(pid));
  return `ps -o pgid= -o command= -p ${quotedPid} 2>/dev/null || ps -l -p ${quotedPid} 2>/dev/null`;
}

function parseProcessInspection(output: string): { processGroupId: number; command: string } | undefined {
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const compact = lines[0]?.match(/^(\d+)\s+(.+)$/u);
  if (compact) {
    const processGroupId = Number(compact[1]);
    if (Number.isSafeInteger(processGroupId) && processGroupId > 0) {
      return { processGroupId, command: compact[2] ?? '' };
    }
  }

  for (const line of lines) {
    const fields = line.split(/\s+/u);
    if (fields.length < 8 || !/^\d+$/u.test(fields[0] ?? '') || !/^\d+$/u.test(fields[2] ?? '')) continue;
    const processGroupId = Number(fields[2]);
    if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) continue;
    return { processGroupId, command: fields.slice(7).join(' ') };
  }
  return undefined;
}

/**
 * Git Bash's `ps` omits arguments, so there a fresh heartbeat marker is what identifies the runner to a stop. The
 * heartbeat ignores the signals sent to the process group and lasts as long as the runner, so a SIGKILL that follows a
 * SIGTERM the command ignored still finds the runner.
 */
function createRunnerScript(job: BackgroundBashJob): string {
  const id = shellQuote(job.meta.id);
  const processToken = shellQuote(job.meta.processToken ?? '');
  const commandPath = shellQuote(job.meta.commandPath);
  const completionPath = shellQuote(job.meta.completionPath);
  const outputPath = shellQuote(job.meta.logPath);
  const markerPath = shellQuote(join(job.meta.jobDir, 'runner-heartbeat'));
  return `#!/bin/sh
set +e
job_id=${id}
process_token=${processToken}
command_path=${commandPath}
completion_path=${completionPath}
output_path=${outputPath}
marker_path=${markerPath}
started_at=${job.meta.startedAt}
child_pid=
heartbeat_pid=

write_heartbeat() {
  timestamp=$(date +%s)
  tmp_path="$marker_path.$$.$timestamp.tmp"
  printf '%s\\n%s\\n%s\\n%s\\n' "$job_id" "$process_token" "$$" "$timestamp" > "$tmp_path"
  mv "$tmp_path" "$marker_path"
}

heartbeat() {
  trap '' TERM INT HUP
  while kill -0 "$$" 2>/dev/null; do
    write_heartbeat || rm -f "$tmp_path" 2>/dev/null
    sleep 1
  done
}

stop_heartbeat() {
  if [ -n "$heartbeat_pid" ]; then
    kill -KILL "$heartbeat_pid" 2>/dev/null
    wait "$heartbeat_pid" 2>/dev/null
    heartbeat_pid=
  fi
}

write_completion() {
  status="$1"
  exit_code="$2"
  signal_name="$3"
  completed_at=$(($(date +%s) * 1000))
  if [ "$signal_name" = "null" ]; then
    signal_json=null
  else
    signal_json="\\\"$signal_name\\\""
  fi
  tmp_path="$completion_path.$$.$completed_at.tmp"
  cat > "$tmp_path" <<EOF
{
  "id": "$job_id",
  "status": "$status",
  "startedAt": $started_at,
  "updatedAt": $completed_at,
  "pid": $$,
  "exitCode": $exit_code,
  "signal": $signal_json,
  "completedAt": $completed_at
}
EOF
  mv "$tmp_path" "$completion_path"
}

terminate() {
  signal_name="$1"
  short_signal=\${signal_name#SIG}
  if [ -n "$child_pid" ]; then
    kill -"$short_signal" "$child_pid" 2>/dev/null
    wait "$child_pid" 2>/dev/null
  fi
  stop_heartbeat
  write_completion killed null "$signal_name"
  exit 143
}

trap 'terminate SIGTERM' TERM
trap 'terminate SIGINT' INT
trap 'terminate SIGHUP' HUP

heartbeat &
heartbeat_pid=$!

sh "$command_path" >> "$output_path" 2>&1 &
child_pid=$!
wait "$child_pid"
exit_code=$?
trap - TERM INT HUP
stop_heartbeat

if [ ! -f "$completion_path" ]; then
  if [ "$exit_code" -eq 0 ]; then
    write_completion completed "$exit_code" null
  else
    write_completion failed "$exit_code" null
  fi
fi
exit "$exit_code"
`;
}

function parseLaunchResult(output: string): { pid: number; processGroupId?: number } | undefined {
  const match = output.trim().match(/(?:^|\n)(?:group:(\d+):(\d+)|pid:(\d+))$/u);
  if (!match) return undefined;
  const pid = Number(match[1] ?? match[3]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const processGroupId = match[2] === undefined ? undefined : Number(match[2]);
  if (processGroupId !== undefined && (!Number.isSafeInteger(processGroupId) || processGroupId <= 0)) {
    return undefined;
  }
  return { pid, ...(processGroupId === undefined ? {} : { processGroupId }) };
}

function containsPosixPath(command: string, path: string): boolean {
  const normalizedPath = path.replaceAll('\\', '/');
  const variants = [normalizedPath];
  const drivePath = normalizedPath.match(/^([a-z]):\/(.*)$/iu);
  if (drivePath) variants.push(`/${drivePath[1]!.toLowerCase()}/${drivePath[2]}`);
  const normalizedCommand = command.replaceAll('\\', '/');
  return variants.some((variant) => normalizedCommand.includes(variant));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error('aborted'));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compareJobsForList(a: BackgroundBashJob, b: BackgroundBashJob): number {
  const aRunning = a.status.status === 'running';
  const bRunning = b.status.status === 'running';
  if (aRunning !== bRunning) return aRunning ? -1 : 1;
  return b.meta.startedAt - a.meta.startedAt;
}

function trackLaunch(path: string): () => void {
  const key = resolve(path);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  pendingLaunches.set(key, pending);
  return () => {
    if (pendingLaunches.get(key) === pending) pendingLaunches.delete(key);
    finish();
  };
}
