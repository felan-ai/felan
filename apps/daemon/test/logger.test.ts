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

describe('redact', () => {
  it('masks query keys, Google API keys and URL credentials', async () => {
    const { redact } = await import('../src/logger.js');
    const google = `AIza${'A1b2C3d4'.repeat(4)}`;
    const value = redact(`GET https://api.example.test/v1?key=k-secret&api-key=a-secret&apikey=b-secret&q=1 ${google} postgres://admin:pa55@db.example.test/x`);
    for (const secret of ['k-secret', 'a-secret', 'b-secret', google, 'admin:pa55']) expect(value).not.toContain(secret);
    expect(value).toContain('q=1'); expect(value).toContain('postgres://[redacted]@db.example.test/x');
  });
});
