import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { AgentRuntime, AgentRuntimeProcess, AgentRuntimeStorage } from '@felan-ai/agent-core';

export const FOREGROUND_MAX_LINES = 2000;
export const FOREGROUND_MAX_BYTES = 50 * 1024;
/** @internal */
export const RETAINED_SPILL_FILES = 20;

export type ForegroundRunResult =
  | { kind: 'exited'; output: string; exitCode?: number; signal?: 'SIGTERM' | 'SIGKILL'; truncated: boolean; fullOutputPath?: string }
  | { kind: 'timeout'; process: AgentRuntimeProcess; startedAt: number };

export async function runForegroundCommand(runtime: AgentRuntime, command: string, options: {
  timeoutMs: number;
  storage: AgentRuntimeStorage;
  spillDir: string;
  signal?: AbortSignal;
}): Promise<ForegroundRunResult> {
  if (!runtime.processes) throw new Error('Runtime does not support processes');
  if (Number.isNaN(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('timeoutMs must be positive');
  const { storage } = options;
  const startedAt = Date.now();
  const process = await runtime.processes.startShell(command, { cwd: runtime.cwd, shellFlavor: 'posix', login: false });
  let offset = 0;
  let newlines = 0;
  let lastByte: number | undefined;
  const tail: Uint8Array[] = [];
  let tailBytes = 0;
  let pending: Uint8Array[] = [];
  let truncated = false;
  let spillFailed = false;
  let fullOutputPath: string | undefined;

  try {
    while (true) {
      if (options.signal?.aborted) throw new Error('Command cancelled');
      const remaining = Math.max(0, startedAt + options.timeoutMs - Date.now());
      const snapshot = await process.read(offset, {
        waitMs: Math.min(1_000, remaining),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (options.signal?.aborted) throw new Error('Command cancelled');
      if (snapshot.nextOffset > offset + snapshot.output.byteLength) truncated = true;
      offset = snapshot.nextOffset;
      const output = snapshot.output;
      if (output.byteLength > 0) {
        for (const byte of output) if (byte === 10) newlines += 1;
        lastByte = output[output.byteLength - 1];
        const lines = newlines + (lastByte === 10 ? 0 : 1);
        if (offset > FOREGROUND_MAX_BYTES || lines > FOREGROUND_MAX_LINES) {
          truncated = true;
          if (!spillFailed) {
            try {
              if (!fullOutputPath) {
                await storage.mkdir(options.spillDir, { recursive: true });
                const timestamp = new Date().toISOString().replace(/\D/gu, '').slice(0, 14);
                fullOutputPath = join(options.spillDir, `output-${timestamp}-${randomBytes(3).toString('hex')}.log`);
                const content = new Uint8Array(pending.reduce((size, chunk) => size + chunk.byteLength, 0));
                let position = 0;
                for (const chunk of pending) {
                  content.set(chunk, position);
                  position += chunk.byteLength;
                }
                await storage.writeFile(fullOutputPath, content);
                pending = [];
                await storage.appendFile(fullOutputPath, output);
                await pruneSpills(storage, options.spillDir);
              } else {
                await storage.appendFile(fullOutputPath, output);
              }
            } catch {
              spillFailed = true;
              fullOutputPath = undefined;
              pending = [];
            }
          }
        } else {
          pending.push(output);
        }
        const retained = output.byteLength > 2 * FOREGROUND_MAX_BYTES ? output.slice(-2 * FOREGROUND_MAX_BYTES) : output;
        tail.push(retained);
        tailBytes += retained.byteLength;
        while (tailBytes > 2 * FOREGROUND_MAX_BYTES) {
          const first = tail[0]!;
          const excess = tailBytes - 2 * FOREGROUND_MAX_BYTES;
          if (first.byteLength <= excess) {
            tail.shift();
            tailBytes -= first.byteLength;
          } else {
            tail[0] = first.subarray(excess);
            tailBytes -= excess;
          }
        }
      }
      if (options.signal?.aborted) throw new Error('Command cancelled');
      if (!snapshot.running && output.byteLength === 0) {
        await process.dispose();
        return {
          kind: 'exited', output: decodeTail(tail, tailBytes), truncated,
          ...(snapshot.exitCode === undefined ? {} : { exitCode: snapshot.exitCode }),
          ...(snapshot.signal === undefined ? {} : { signal: snapshot.signal }),
          ...(fullOutputPath === undefined ? {} : { fullOutputPath }),
        };
      }
      if (snapshot.running && Date.now() >= startedAt + options.timeoutMs) return { kind: 'timeout', process, startedAt };
    }
  } catch (error) {
    const failures: unknown[] = [];
    try { await process.terminate('SIGTERM'); } catch (failure) { failures.push(failure); }
    try { await process.dispose(); } catch (failure) { failures.push(failure); }
    if (options.signal?.aborted) throw new Error('Command cancelled', { cause: failures.length ? new AggregateError(failures) : error });
    if (failures.length) throw new AggregateError([error, ...failures], 'Command and process cleanup failed');
    throw error;
  }
}

function decodeTail(chunks: Uint8Array[], size: number): string {
  const bytes = new Uint8Array(size);
  let position = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, position);
    position += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes).replace(/\r?\n$/u, '').split('\n').slice(-FOREGROUND_MAX_LINES).join('\n');
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
  return text.slice(start);
}

async function pruneSpills(storage: AgentRuntimeStorage, spillDir: string): Promise<void> {
  try {
    const files = (await storage.listFiles(spillDir, { pattern: 'output-*.log' })).sort();
    await Promise.allSettled(files.slice(0, -RETAINED_SPILL_FILES).map((file) => storage.remove(join(spillDir, file))));
  } catch {}
}
