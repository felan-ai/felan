import type { AgentRuntime } from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveCredential } from '../src/credentials.js';

describe('credential sources', () => {
  const original = process.env.WEB_ACCESS_TEST_KEY;

  afterEach(() => {
    if (original === undefined) delete process.env.WEB_ACCESS_TEST_KEY;
    else process.env.WEB_ACCESS_TEST_KEY = original;
  });

  it('keeps legacy environment precedence for literal config values', async () => {
    process.env.WEB_ACCESS_TEST_KEY = 'environment-key';
    await expect(resolveCredential({
      provider: 'Test',
      configuredValue: 'literal-key',
      environmentName: 'WEB_ACCESS_TEST_KEY',
      runtime: runtime(),
    })).resolves.toBe('environment-key');
  });

  it('supports explicit environment and escaped literal sources', async () => {
    process.env.WEB_ACCESS_TEST_KEY = 'explicit-key';
    await expect(resolveCredential({
      provider: 'Test',
      configuredValue: '$WEB_ACCESS_TEST_KEY',
      environmentName: 'UNUSED_KEY',
      runtime: runtime(),
    })).resolves.toBe('explicit-key');
    await expect(resolveCredential({
      provider: 'Test',
      configuredValue: '$$literal-key',
      environmentName: 'UNUSED_KEY',
      runtime: runtime(),
    })).resolves.toBe('$literal-key');
  });

  it('runs trusted command sources through AgentRuntime with an empty child environment', async () => {
    const agentRuntime = runtime({ stdout: 'command-key\n', stderr: 'ignored', code: 0, killed: false });
    await expect(resolveCredential({
      provider: 'Test',
      configuredValue: '!secret-manager read test',
      environmentName: 'UNUSED_KEY',
      runtime: agentRuntime,
    })).resolves.toBe('command-key');
    expect(agentRuntime.exec).toHaveBeenCalledWith('/usr/bin/env', expect.arrayContaining([
      '-i',
      '/bin/sh',
      '-lc',
      'secret-manager read test',
    ]), expect.objectContaining({ timeout: 5_000 }));
  });
});

function runtime(result = { stdout: '', stderr: '', code: 0, killed: false }): AgentRuntime {
  return { exec: vi.fn(async () => result) } as unknown as AgentRuntime;
}
