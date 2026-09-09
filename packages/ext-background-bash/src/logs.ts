import type { AgentRuntime, AgentRuntimeStorage } from '@felan-ai/agent-core';
import { shellQuote } from './runtime-support.js';

const DEFAULT_TAIL_LINES = 80;
const MAX_TAIL_BYTES = 128 * 1024;
// Four extra bytes keep a split leading UTF-8 character outside the retained tail.
const TAIL_READ_BYTES = MAX_TAIL_BYTES + 4;
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
    content = await storage.readFile(logPath, { maxBytes: MAX_TAIL_BYTES });
  } catch (error) {
    if (isMissingPathError(error)) return '(log file not found)';
    if (!isReadLimitError(error)) throw error;
    const result = await runtime.shell(`tail -c ${TAIL_READ_BYTES} -- ${shellQuote(logPath)}`, {
      shellFlavor: 'posix',
      maxOutputBytes: TAIL_READ_BYTES,
      timeout: 5_000,
    });
    if (result.killed) throw new Error('Reading process log timed out or was terminated');
    if (result.code !== 0) throw new Error(result.stderr.trim() || `Unable to read process log (exit ${result.code})`);
    if (result.truncated) throw new Error('Process log tail exceeded its read bound');
    content = encoder.encode(result.stdout);
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

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function isReadLimitError(error: unknown): boolean {
  return error instanceof Error && /exceeds maximum size of \d+ bytes/u.test(error.message);
}
