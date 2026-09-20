import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LOCAL_AGENT_LOG_PATH,
  appendLocalLogLine,
  createLocalAgentLogger,
  resolveLocalLoggerLevel,
} from '../src/logger.js';

describe('local agent logger', () => {
  it('defaults to debug and treats off as silent', () => {
    expect(resolveLocalLoggerLevel(undefined)).toBe('debug');
    expect(resolveLocalLoggerLevel('OFF')).toBe('off');
    expect(resolveLocalLoggerLevel('nope')).toBe('debug');
    expect(createLocalAgentLogger('/tmp/unused', 'off').level).toBe('off');
  });

  it('appends JSONL under agent storage without secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'felan-agent-log-'));
    await appendLocalLogLine(root, {
      level: 'debug',
      time: '2026-09-19T12:00:00.000Z',
      fields: { sessionId: 'session-1', error: 'Bearer secret-token failed' },
      msg: 'session compaction prune',
    });
    const line = JSON.parse(await readFile(join(root, LOCAL_AGENT_LOG_PATH), 'utf8'));
    expect(line).toMatchObject({
      time: '2026-09-19T12:00:00.000Z',
      level: 'debug',
      sessionId: 'session-1',
      msg: 'session compaction prune',
    });
    expect(line.error).toContain('Bearer [redacted]');
    expect(line.error).not.toContain('secret-token');
  });
});
