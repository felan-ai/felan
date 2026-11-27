import type { AgentRuntime, AgentRuntimeStorage } from '@felan-ai/agent-core';
import type { BackgroundBashJob } from './job-store.js';
import { isTerminalStatus } from './job-store.js';
import { readLogBytes } from './logs.js';
import type { BackgroundBashManager, ForegroundExit } from './process-manager.js';

export const FOREGROUND_MAX_LINES = 2000;
export const FOREGROUND_MAX_BYTES = 50 * 1024;

export type ForegroundRunResult =
  | { kind: 'exited'; output: string; exitCode?: number; signal?: string; truncated: boolean; fullOutputPath?: string }
  | { kind: 'timeout'; job: BackgroundBashJob };

/**
 * Runs a command as a detached job and waits on it, so a command that outlives the timeout is already a
 * job that survives the daemon. A job that finishes in time is removed unless its full output is needed.
 */
export async function runForegroundCommand(
  manager: BackgroundBashManager,
  runtime: Pick<AgentRuntime, 'shell'>,
  storage: AgentRuntimeStorage,
  command: string,
  options: { timeoutMs: number; noticeSession: string; signal?: AbortSignal },
): Promise<ForegroundRunResult> {
  if (Number.isNaN(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('timeoutMs must be positive');
  const job = await manager.startForeground(command, options.noticeSession);
  const id = job.meta.id;
  try {
    let finished = await manager.waitForForeground(job, Date.now() + options.timeoutMs, options.signal);
    if (!finished) {
      const promoted = await manager.markPromoted(id, 'detached');
      if (!promoted) throw new Error(`Background process disappeared during promotion: ${id}`);
      if (!isTerminalStatus(promoted.status.status)) return { kind: 'timeout', job: promoted };
      finished = { job: promoted };
    }
    return await collectForegroundResult(manager, runtime, storage, finished, options.noticeSession);
  } catch (error) {
    const failures: unknown[] = [];
    try { await discardForegroundJob(manager, id); } catch (failure) { failures.push(failure); }
    if (options.signal?.aborted) throw new Error('Command cancelled', { cause: failures.length ? new AggregateError(failures) : error });
    if (failures.length) throw new AggregateError([error, ...failures], 'Command and process cleanup failed');
    throw error;
  }
}

/** Stops and removes an abandoned foreground job; one that survives SIGKILL is promoted so it stays visible and stoppable. */
async function discardForegroundJob(manager: BackgroundBashManager, id: string): Promise<void> {
  try {
    await manager.stop(id, 'SIGTERM');
  } catch {
    try {
      await manager.stop(id, 'SIGKILL');
    } catch (error) {
      await manager.markPromoted(id, 'detached');
      throw error;
    }
  }
  await manager.removeJob(id);
}

async function collectForegroundResult(
  manager: BackgroundBashManager,
  runtime: Pick<AgentRuntime, 'shell'>,
  storage: AgentRuntimeStorage,
  { job, output }: ForegroundExit,
  noticeSession: string,
): Promise<ForegroundRunResult> {
  const content = output?.content ?? await readLogBytes(runtime, storage, job.meta.logPath, 2 * FOREGROUND_MAX_BYTES);
  const tail = decodeTail(content);
  const truncated = content.byteLength > 2 * FOREGROUND_MAX_BYTES || tail.truncated;
  // A truncated result points at the job's log, so the job is kept, unlisted, until retention removes it.
  // The wait call removes only a job whose log is too small to truncate.
  if (!output?.removed) {
    if (truncated) await manager.settleNotice(job.meta.id, noticeSession);
    else await manager.removeJob(job.meta.id);
  }
  const exitCode = job.status.exitCode ?? undefined;
  const signal = job.status.signal ?? undefined;
  return {
    kind: 'exited', output: tail.text, truncated,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal === undefined ? {} : { signal }),
    ...(truncated ? { fullOutputPath: job.meta.logPath } : {}),
  };
}

function decodeTail(bytes: Uint8Array): { text: string; truncated: boolean } {
  let begin = 0;
  while (begin < bytes.byteLength && begin < 4 && (bytes[begin]! & 0xc0) === 0x80) begin += 1;
  const lines = new TextDecoder().decode(bytes.subarray(begin)).replace(/\r?\n$/u, '').split('\n');
  const text = lines.slice(-FOREGROUND_MAX_LINES).join('\n');
  let start = text.length;
  let retainedBytes = 0;
  while (start > 0) {
    const code = text.charCodeAt(start - 1);
    const paired = code >= 0xdc00 && code <= 0xdfff;
    const width = paired ? 4 : code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
    if (retainedBytes + width > FOREGROUND_MAX_BYTES) break;
    retainedBytes += width;
    start -= paired ? 2 : 1;
  }
  return { text: text.slice(start), truncated: lines.length > FOREGROUND_MAX_LINES || start > 0 };
}
