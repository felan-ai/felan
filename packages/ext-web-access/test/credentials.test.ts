import type { AgentRuntime } from '@felan-ai/agent-core';
import { resolveExtensionConfigs } from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WEB_ACCESS_CONFIG } from '../src/config.js';
import { resolveCredential } from '../src/credentials.js';

describe('search credential sources', () => {
  const original = process.env.WEB_ACCESS_TEST_KEY;

  afterEach(() => {
    if (original === undefined) delete process.env.WEB_ACCESS_TEST_KEY;
    else process.env.WEB_ACCESS_TEST_KEY = original;
  });

  it('declares every search credential setting sensitive and validates SearXNG endpoints', () => {
    expect(WEB_ACCESS_CONFIG.fields.openaiApiKey.sensitive).toBe(true);
    expect(WEB_ACCESS_CONFIG.fields.exaApiKey.sensitive).toBe(true);
    expect(WEB_ACCESS_CONFIG.fields.braveApiKey.sensitive).toBe(true);
    expect(WEB_ACCESS_CONFIG.fields.searxngHeaders.sensitive).toBe(true);
    expect(() => resolveExtensionConfigs([WEB_ACCESS_CONFIG], [{
      extensionId: 'webAccess',
      values: { searxngBaseUrl: 'https://user:secret@search.example' },
      source: 'test',
    }])).toThrow('must be an HTTP(S) URL without credentials');
  });

  it('preserves environment precedence and explicit or escaped sources', async () => {
    process.env.WEB_ACCESS_TEST_KEY = 'environment-key';
    await expect(resolveCredential({
      provider: 'Test',
      configuredValue: 'literal-key',
      environmentName: 'WEB_ACCESS_TEST_KEY',
      runtime: runtime(),
    })).resolves.toBe('environment-key');
    await expect(resolveCredential({
      provider: 'Test',
      configuredValue: '$WEB_ACCESS_TEST_KEY',
      environmentName: 'UNUSED_KEY',
      runtime: runtime(),
    })).resolves.toBe('environment-key');
    await expect(resolveCredential({
      provider: 'Test',
      configuredValue: '$$literal-key',
      environmentName: 'UNUSED_KEY',
      runtime: runtime(),
    })).resolves.toBe('$literal-key');
  });

  it('runs trusted command sources through AgentRuntime with a restricted child environment', async () => {
    const agentRuntime = runtime({ stdout: 'command-key\n', stderr: 'ignored', code: 0, killed: false });
    await expect(resolveCredential({
      provider: 'Test',
      configuredValue: '!secret-manager read test',
      environmentName: 'UNUSED_KEY',
      runtime: agentRuntime,
    })).resolves.toBe('command-key');
    expect(agentRuntime.shell).toHaveBeenCalledWith(
      expect.stringMatching(/^env -i .* \/bin\/sh -lc 'secret-manager read test'$/u),
      expect.objectContaining({ maxOutputBytes: 16_384, shellFlavor: 'posix', timeout: 5_000 }),
    );
  });

  it('bounds combined credential-command output during capture', async () => {
    const agentRuntime = runtime({
      stdout: 'partial-key',
      stderr: 'noisy command output',
      code: 0,
      killed: false,
      truncated: true,
    });
    await expect(resolveCredential({
      provider: 'Test',
      configuredValue: '!secret-manager read test',
      environmentName: 'UNUSED_KEY',
      runtime: agentRuntime,
    })).rejects.toThrow('credential command output is too large');
    expect(agentRuntime.shell).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ maxOutputBytes: 16_384 }),
    );
  });
});

function runtime(result: {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
  truncated?: boolean;
} = { stdout: '', stderr: '', code: 0, killed: false }): AgentRuntime {
  return { shell: vi.fn(async () => result) } as unknown as AgentRuntime;
}
