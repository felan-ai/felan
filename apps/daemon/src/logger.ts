import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createLogger,
  createSilentLogger,
  isLoggerLevel,
  type Logger,
  type LoggerLevel,
  type LogRecord,
} from '@felan-ai/agent-core';

export const FELAN_LOG_LEVEL_ENV = 'FELAN_LOG_LEVEL';
export const LOCAL_AGENT_LOG_PATH = join('logs', 'felan.jsonl');

export function resolveLocalLoggerLevel(
  value: string | undefined = process.env[FELAN_LOG_LEVEL_ENV],
): LoggerLevel {
  const spec = value?.trim().toLowerCase();
  if (!spec) return 'debug';
  return isLoggerLevel(spec) ? spec : 'debug';
}

export function createLocalAgentLogger(
  agentStorageRoot: string,
  level: LoggerLevel = resolveLocalLoggerLevel(),
): Logger {
  if (level === 'off') return createSilentLogger();
  return createLogger({
    level,
    destination: {
      write: (record) => {
        void appendLocalLogLine(agentStorageRoot, record);
      },
    },
  });
}

export async function appendLocalLogLine(agentStorageRoot: string, record: LogRecord): Promise<void> {
  try {
    const directory = join(agentStorageRoot, 'logs');
    await mkdir(directory, { recursive: true });
    const payload: Record<string, unknown> = {
      time: record.time,
      level: record.level,
      ...record.fields,
    };
    if (record.msg !== undefined) payload.msg = record.msg;
    await appendFile(join(agentStorageRoot, LOCAL_AGENT_LOG_PATH), `${redact(JSON.stringify(payload))}\n`, {
      encoding: 'utf8',
    });
  } catch {
    /* logging must not affect the session */
  }
}

/** Masks credential-shaped substrings in diagnostics that may quote provider responses or credential files. */
export function redact(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@:]+:[^\s/?#@]*@/giu, '$1[redacted]@')
    .replace(/([?&](?:code|state|token|access_token|refresh_token|client_secret|key|api[_-]?key)=)[^&#\s]*/giu, '$1[redacted]')
    .replace(/(["']?\b[\w-]*(?:api[_-]?key|token|secret|password|authorization|credential)[\w-]*["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/giu, '$1[redacted]')
    .replace(/\bfln_pat_[A-Za-z0-9_-]+/gu, '[redacted]')
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/gu, '[redacted]')
    .replace(/\b(?:gh[pousr]_|github_pat_|xox[abpr]-|AKIA)[A-Za-z0-9_-]{8,}/gu, '[redacted]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/gu, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, '[redacted]');
}
