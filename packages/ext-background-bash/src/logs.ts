import type { AgentRuntime, AgentRuntimeStorage } from '@felan-ai/agent-core';
import { shellQuote } from './runtime-support.js';

const DEFAULT_TAIL_LINES = 80;
const MAX_TAIL_BYTES = 128 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function createOutputLog(storage: AgentRuntimeStorage, logPath: string): Promise<void> {
  await storage.writeFile(logPath, encoder.encode(''));
}

export async function readLogTail(
  runtime: Pick<AgentRuntime, 'shell'>,
  storage: AgentRuntimeStorage,
  logPath: string,
  lines = DEFAULT_TAIL_LINES,
): Promise<string> {
  const maxLines = Math.max(1, lines);
  let content: Uint8Array;
  try {
    content = await readLogBytes(runtime, storage, logPath, MAX_TAIL_BYTES);
  } catch (error) {
    if (isMissingPathError(error)) return '(log file not found)';
    throw error;
  }
  if (content.byteLength === 0) return '(log is empty)';
  const truncatedByBytes = content.byteLength > MAX_TAIL_BYTES;
  let start = Math.max(0, content.byteLength - MAX_TAIL_BYTES);
  while (start < content.byteLength && (content[start]! & 0xc0) === 0x80) start += 1;
  const text = decoder.decode(content.subarray(start)).replace(/\r?\n$/u, '');
  const allLines = text.split(/\r?\n/u);
  if (truncatedByBytes && allLines.length > 1) allLines.shift();
  const selected = allLines.slice(-maxLines).join('\n');
  if (truncatedByBytes || allLines.length > maxLines) {
    return `[Showing last ${maxLines} log lines. Full output: ${logPath}]\n${selected}`;
  }
  return selected;
}

/** Reads a whole log of at most `maxBytes`, or a little more than its last `maxBytes`, so a longer result means the log was cut. */
export async function readLogBytes(
  runtime: Pick<AgentRuntime, 'shell'>,
  storage: AgentRuntimeStorage,
  logPath: string,
  maxBytes: number,
): Promise<Uint8Array> {
  try {
    return await storage.readFile(logPath, { maxBytes });
  } catch (error) {
    if (!isReadLimitError(error)) throw error;
  }
  // Four extra bytes keep a split leading UTF-8 character outside the retained tail.
  const readBytes = maxBytes + 4;
  const result = await runtime.shell(`tail -c ${readBytes} -- ${shellQuote(logPath)}`, {
    shellFlavor: 'posix',
    maxOutputBytes: readBytes,
    timeout: 5_000,
  });
  if (result.killed) throw new Error('Reading process log timed out or was terminated');
  if (result.code !== 0) throw new Error(result.stderr.trim() || `Unable to read process log (exit ${result.code})`);
  if (result.truncated) throw new Error('Process log tail exceeded its read bound');
  return encoder.encode(result.stdout);
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function isReadLimitError(error: unknown): boolean {
  return error instanceof Error && /exceeds maximum size of \d+ bytes/u.test(error.message);
}
