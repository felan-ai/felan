import { join } from 'node:path';
import type { AgentRuntime, AgentRuntimeStorage } from '@felan-ai/agent-core';
import { BackgroundBashCoordinator, type InteractiveBashProcess } from './coordinator.js';
import { shellQuote } from './runtime-support.js';
import { createOutputLog, readLogTail } from './logs.js';
import {
  BackgroundBashJobStore,
  type BackgroundBashJob,
  type BackgroundBashStatusFilter,
  isBackgroundBashJobId,
  isTerminalStatus,
} from './job-store.js';

export interface WaitBackgroundBashResult {
  job: BackgroundBashJob;
  timedOut: boolean;
}

const WAIT_POLL_MS = 500;
const PROCESS_STATUS_GRACE_MS = 5_000;
const STOP_PROCESS_WAIT_MS = 5_000;
const RUNNER_MARKER_MAX_AGE_SECONDS = 3;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const pendingLaunches = new Map<string, Promise<void>>();

export class BackgroundBashManager {
  readonly #store: BackgroundBashJobStore;
  readonly #storage: AgentRuntimeStorage;

  readonly #coordinator: BackgroundBashCoordinator;

  constructor(private readonly runtime: AgentRuntime, coordinator?: BackgroundBashCoordinator) {
    this.#storage = runtime.storage('session');
    this.#store = new BackgroundBashJobStore(runtime, this.#storage);
    this.#coordinator = coordinator ?? new BackgroundBashCoordinator(runtime);
  }

  get coordinator(): BackgroundBashCoordinator {
    return this.#coordinator;
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
        (snapshot) => this.#persistInteractiveSnapshot(job.meta.id, snapshot),
      );
      const updated = await this.#store.updatePid(job.meta.id, process.process.pid ?? 0, undefined, {
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

  async start(command: string): Promise<BackgroundBashJob> {
    const job = await this.#store.createJob(command);
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
    } finally {
      finishLaunch();
    }
  }

  async list(status: BackgroundBashStatusFilter = 'all'): Promise<BackgroundBashJob[]> {
    const jobs = await this.#store.listJobs('all');
    const normalized: BackgroundBashJob[] = [];
    for (const job of jobs) {
      normalized.push(await this.get(job.meta.id));
    }
    return status === 'all'
      ? normalized
      : normalized.filter((job) => job.status.status === status);
  }

  async get(id: string): Promise<BackgroundBashJob> {
    const wasStarting = pendingLaunches.has(join(this.#store.jobsDir, id));
    const job = await this.#store.readJob(id);
    if (!job) throw new Error(`Background process not found: ${id}`);
    if (wasStarting || pendingLaunches.has(job.meta.jobDir) || this.#coordinator.isStarting(id)) return job;
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
    await pendingLaunches.get(join(this.#store.jobsDir, id));
    if (this.#coordinator.has(id)) {
      await this.stopInteractive(id, signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM');
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
  while write_heartbeat; do
    sleep 1
  done
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
  if [ -n "$heartbeat_pid" ]; then
    kill "$heartbeat_pid" 2>/dev/null
    wait "$heartbeat_pid" 2>/dev/null
  fi
  short_signal=\${signal_name#SIG}
  if [ -n "$child_pid" ]; then
    kill -"$short_signal" "$child_pid" 2>/dev/null
    wait "$child_pid" 2>/dev/null
  fi
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

if [ -n "$heartbeat_pid" ]; then
  kill "$heartbeat_pid" 2>/dev/null
  wait "$heartbeat_pid" 2>/dev/null
fi

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

function trackLaunch(path: string): () => void {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  pendingLaunches.set(path, pending);
  return () => {
    if (pendingLaunches.get(path) === pending) pendingLaunches.delete(path);
    finish();
  };
}
