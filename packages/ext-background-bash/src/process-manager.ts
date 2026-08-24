import { join } from 'node:path';
import type { AgentRuntime, AgentRuntimeStorage } from '@felan-ai/agent-core';
import { createOutputLog, readLogTail } from './logs.js';
import {
  BackgroundBashJobStore,
  type BackgroundBashJob,
  type BackgroundBashStatusFilter,
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

export class BackgroundBashManager {
  readonly #store: BackgroundBashJobStore;
  readonly #storage: AgentRuntimeStorage;

  constructor(private readonly runtime: AgentRuntime) {
    this.#storage = runtime.storage('session');
    this.#store = new BackgroundBashJobStore(runtime, this.#storage);
  }

  async start(command: string): Promise<BackgroundBashJob> {
    let job = await this.#store.createJob(command);
    await createOutputLog(this.#storage, job.meta.logPath);
    await this.#storage.writeFile(job.meta.commandPath, encoder.encode(`${command}\n`));
    await this.#storage.writeFile(job.meta.runnerPath, encoder.encode(createRunnerScript(job)));

    try {
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
      const launchedProcess = parseLaunchResult(launch.stdout);
      if (!launchedProcess) throw new Error('Background runner did not report a process id');
      job = await this.#store.updatePid(
        job.meta.id,
        launchedProcess.pid,
        launchedProcess.processGroupId,
      ) ?? job;
      return job;
    } catch (error) {
      await this.#store.markStatus(job.meta.id, {
        status: 'failed',
        exitCode: null,
        signal: null,
        error: errorMessage(error),
      });
      throw new Error(`Failed to start background bash process: ${errorMessage(error)}`, { cause: error });
    }
  }

  async list(status: BackgroundBashStatusFilter = 'all'): Promise<BackgroundBashJob[]> {
    const jobs = await this.#store.listJobs('all');
    const normalized: BackgroundBashJob[] = [];
    for (const job of jobs) normalized.push(await this.#normalizeJob(job));
    return status === 'all'
      ? normalized
      : normalized.filter((job) => job.status.status === status);
  }

  async get(id: string): Promise<BackgroundBashJob> {
    const job = await this.#store.readJob(id);
    if (!job) throw new Error(`Background Bash process not found: ${id}`);
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
      if (!unknown) throw new Error(`Background Bash process not found: ${id}`);
      return unknown;
    }

    let result = inspected?.processGroupId === pid
      ? await this.#sendSignal(-inspected.processGroupId, signal)
      : await this.#sendSignal(pid, signal);
    if (result.code !== 0 && inspected?.processGroupId === pid) {
      result = await this.#sendSignal(pid, signal);
    }
    if (result.code !== 0) {
      throw new Error(result.stderr || `Unable to send ${signal} to Background Bash process ${id}`);
    }

    if (!await this.#waitForProcessExit(pid)) {
      return await this.#store.markStatus(id, {
        status: 'unknown',
        pid,
        exitCode: null,
        signal: null,
        error: `Process did not exit after ${STOP_PROCESS_WAIT_MS / 1_000} seconds.`,
      }) ?? job;
    }

    const completed = await this.#store.readJob(id);
    if (completed && isTerminalStatus(completed.status.status)) return completed;
    const killed = await this.#store.markStatus(id, {
      status: 'killed',
      pid,
      exitCode: null,
      signal,
    });
    if (!killed) throw new Error(`Background Bash process not found: ${id}`);
    return killed;
  }

  async tail(id: string, lines = 80): Promise<string> {
    const job = await this.get(id);
    return readLogTail(this.#storage, job.meta.logPath, lines);
  }

  async #normalizeJob(job: BackgroundBashJob): Promise<BackgroundBashJob> {
    if (job.status.status !== 'running') return job;

    const pid = job.status.pid ?? job.meta.pid;
    const now = Date.now();
    if (now - job.status.startedAt <= PROCESS_STATUS_GRACE_MS) return job;
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
    const result = await this.runtime.shell(`kill -0 -- ${shellQuote(String(pid))} 2>/dev/null`, {
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
    const target = pid < 0 ? String(pid) : `-- ${shellQuote(String(pid))}`;
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

function shellQuote(value: string): string {
  const normalized = process.platform === 'win32' ? value.replaceAll('\\', '/') : value;
  return `'${normalized.replaceAll("'", `'\\''`)}'`;
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
