import type { AgentRuntimeStorage } from '@felan-ai/agent-core';

const DEFAULT_TAIL_LINES = 80;
const MAX_TAIL_BYTES = 128 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function createOutputLog(storage: AgentRuntimeStorage, logPath: string): Promise<void> {
  await storage.writeFile(logPath, encoder.encode(''));
}

export async function readLogTail(
  storage: AgentRuntimeStorage,
  logPath: string,
  lines = DEFAULT_TAIL_LINES,
): Promise<string> {
  const maxLines = Math.max(1, lines);
  try {
    const content = await storage.readFile(logPath);
    const truncatedByBytes = content.byteLength > MAX_TAIL_BYTES;
    const selectedBytes = truncatedByBytes ? content.slice(-MAX_TAIL_BYTES) : content;
    let text = decoder.decode(selectedBytes);
    if (truncatedByBytes) {
      const firstNewline = text.indexOf('\n');
      if (firstNewline !== -1) text = text.slice(firstNewline + 1);
    }
    const allLines = text.split(/\r?\n/);
    const selected = allLines.slice(-maxLines).join('\n');
    if (truncatedByBytes || allLines.length > maxLines) {
      return `[Showing last ${maxLines} log lines. Full output: ${logPath}]\n${selected}`;
    }
    return selected || '(log is empty)';
  } catch (error) {
    if (isMissingPathError(error)) return '(log file not found)';
    throw error;
  }
}

export async function readWholeLogIfSmall(
  storage: AgentRuntimeStorage,
  logPath: string,
  maxBytes = MAX_TAIL_BYTES,
): Promise<string> {
  const content = await storage.readFile(logPath);
  if (content.byteLength <= maxBytes) return decoder.decode(content);
  return readLogTail(storage, logPath);
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}
