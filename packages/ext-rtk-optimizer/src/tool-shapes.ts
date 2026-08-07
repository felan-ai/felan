import { toRecord } from './record-utils.js';

export const COMMAND_TOOL_NAMES = ['bash', 'exec_command'] as const;
export const STREAMING_COMMAND_TOOL_NAMES = ['bash', 'exec_command', 'write_stdin'] as const;

export type CommandToolName = (typeof COMMAND_TOOL_NAMES)[number];

export function isCommandToolName(toolName: unknown): toolName is CommandToolName {
  return typeof toolName === 'string' && COMMAND_TOOL_NAMES.includes(toolName as CommandToolName);
}

export function isStreamingCommandToolName(toolName: unknown): boolean {
  return (
    typeof toolName === 'string' &&
    STREAMING_COMMAND_TOOL_NAMES.includes(toolName as (typeof STREAMING_COMMAND_TOOL_NAMES)[number])
  );
}

export function readToolCommand(toolName: unknown, input: unknown): string | undefined {
  if (!isCommandToolName(toolName)) return undefined;
  const record = toRecord(input);
  const value = toolName === 'exec_command' ? record.cmd : record.command;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function writeToolCommand(toolName: unknown, input: unknown, command: string): boolean {
  if (!isCommandToolName(toolName)) return false;
  const record = toRecord(input);
  if (Object.keys(record).length === 0) return false;
  if (toolName === 'exec_command') record.cmd = command;
  else record.command = command;
  return true;
}

export function readCodexSessionId(input: unknown): number | undefined {
  const sessionId = toRecord(input).session_id;
  return Number.isSafeInteger(sessionId) ? (sessionId as number) : undefined;
}

export function readRunningCodexSessionId(details: unknown): number | undefined {
  const sessionId = toRecord(details).session_id;
  return Number.isSafeInteger(sessionId) ? (sessionId as number) : undefined;
}

export function codexResultHasExited(details: unknown): boolean {
  return Number.isSafeInteger(toRecord(details).exit_code);
}
