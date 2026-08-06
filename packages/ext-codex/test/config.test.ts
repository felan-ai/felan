import { HostAgentRuntime, type AgentRuntime } from '@felan-ai/agent-core';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CODEX_CONFIG,
  readCodexConfig,
  validateCodexConfig,
} from '../src/index.js';

describe('Codex configuration', () => {
  it('uses minimal defaults when codex.json is absent', async () => {
    await expect(readCodexConfig(runtimeWithConfig(undefined), '/agent'))
      .resolves.toEqual(DEFAULT_CODEX_CONFIG);
  });

  it('uses defaults for runtimes without agent-file support', async () => {
    const { readAgentFile: _readAgentFile, ...runtime } = runtimeWithConfig(undefined);

    await expect(readCodexConfig(runtime, '/agent')).resolves.toEqual(DEFAULT_CODEX_CONFIG);
  });

  it('uses defaults for a HostAgentRuntime without agentDir', async () => {
    const runtime = new HostAgentRuntime('/workspace', {
      sessionStorageRoot: '/session-storage',
      agentStorageRoot: '/agent-storage',
    });

    await expect(readCodexConfig(runtime, '/agent')).resolves.toEqual(DEFAULT_CODEX_CONFIG);
  });

  it('loads all supported settings', async () => {
    await expect(readCodexConfig(runtimeWithConfig({
      fast: true,
      verbosity: 'high',
      forceCachedWebSockets: false,
    }), '/agent')).resolves.toEqual({
      fast: true,
      verbosity: 'high',
      forceCachedWebSockets: false,
    });
  });

  it('rejects unknown and invalid fields with their config path', () => {
    expect(() => validateCodexConfig({ web: true }, '/agent/codex.json'))
      .toThrow('/agent/codex.json contains unknown field: web');
    expect(() => validateCodexConfig({ verbosity: 'max' }, '/agent/codex.json'))
      .toThrow('/agent/codex.json.verbosity must be low, medium, or high');
    expect(() => validateCodexConfig({ fast: 'yes' }, '/agent/codex.json'))
      .toThrow('/agent/codex.json.fast must be a boolean');
  });
});

function runtimeWithConfig(config: unknown | undefined): AgentRuntime {
  return {
    kind: 'host',
    cwd: '/workspace',
    storage: () => unusedStorage(),
    exec: unused,
    shell: unused,
    readFile: unused,
    writeFile: unused,
    listFiles: unused,
    mkdir: unused,
    remove: unused,
    readAgentFile: async () => {
      if (config === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return new TextEncoder().encode(JSON.stringify(config));
    },
  };
}

const unused = async (): Promise<never> => { throw new Error('unused'); };
const unusedStorage = () => ({
  root: '/storage',
  readFile: unused,
  writeFile: unused,
  listFiles: unused,
  mkdir: unused,
  remove: unused,
});
