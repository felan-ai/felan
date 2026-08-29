import type { AgentRuntime } from '@felan-ai/agent-core';
import { describe, expect, it } from 'vitest';
import {
  readLocalMcpConfig,
  validateLocalMcpConfig,
} from '../src/mcp/config.js';

describe('local MCP config', () => {
  it('reads the Felan agent mcp.json and separates OAuth host config', async () => {
    const runtime = runtimeWithConfigs({
      agent: {
        mcpServers: {
          notion: {
            url: 'https://mcp.example.test/mcp',
            auth: 'oauth',
            httpTransport: 'streamable-http',
            oauth: {
              clientId: 'client-id',
              clientSecretEnv: 'NOTION_CLIENT_SECRET',
              scope: 'read write',
              authorizationParams: { access_type: 'offline' },
            },
          },
        },
        settings: { requestTimeoutMs: 15_000 },
      },
    });

    await expect(readLocalMcpConfig(runtime, '/agent')).resolves.toEqual({
      config: {
        mcpServers: {
          notion: {
            url: 'https://mcp.example.test/mcp',
            auth: 'oauth',
            transport: 'streamable-http',
          },
        },
        settings: { requestTimeoutMs: 15_000 },
      },
      oauth: {
        notion: {
          clientId: 'client-id',
          clientSecretEnv: 'NOTION_CLIENT_SECRET',
          scope: 'read write',
          authorizationParams: { access_type: 'offline' },
        },
      },
      warnings: [],
    });
  });

  it('loads standard OAuth HTTP servers from the exact project cwd and skips unsupported entries', async () => {
    const runtime = runtimeWithConfigs({
      project: {
        mcpServers: {
          axiom: { type: 'http', url: 'https://mcp.axiom.test/mcp' },
          events: { type: 'sse', url: 'https://mcp.events.test/sse' },
          sonar: { command: 'npx', args: ['sonar-mcp'] },
          privateApi: {
            type: 'http',
            url: 'https://mcp.private.test/mcp',
            headers: { Authorization: 'secret-value-must-not-appear' },
          },
        },
      },
      cwd: '/workspace/project',
    });

    const loaded = await readLocalMcpConfig(runtime, '/agent');

    expect(loaded.config.mcpServers).toEqual({
      axiom: {
        url: 'https://mcp.axiom.test/mcp',
        auth: 'oauth',
      },
      events: {
        url: 'https://mcp.events.test/sse',
        auth: 'oauth',
        transport: 'sse',
      },
    });
    expect(loaded.warnings).toEqual([
      'Skipped project MCP server "privateApi": custom headers are unsupported',
    ]);
    expect(loaded.warnings.join('\n')).not.toContain('secret-value-must-not-appear');
  });

  it('lets project servers and settings override agent config without inheriting OAuth settings', async () => {
    const runtime = runtimeWithConfigs({
      agent: {
        mcpServers: {
          shared: {
            url: 'https://home.example.test/mcp',
            auth: 'oauth',
            oauth: { clientId: 'home-client', scope: 'home-scope' },
          },
          homeOnly: {
            url: 'https://home-only.example.test/mcp',
            auth: 'oauth',
            oauth: { clientId: 'home-only-client' },
          },
        },
        settings: { requestTimeoutMs: 10_000 },
      },
      project: {
        mcpServers: {
          shared: { type: 'http', url: 'https://project.example.test/mcp' },
        },
        settings: { requestTimeoutMs: 20_000 },
      },
    });

    const loaded = await readLocalMcpConfig(runtime, '/agent');

    expect(loaded.config).toEqual({
      mcpServers: {
        shared: { url: 'https://project.example.test/mcp', auth: 'oauth' },
        homeOnly: { url: 'https://home-only.example.test/mcp', auth: 'oauth' },
      },
      settings: { requestTimeoutMs: 20_000 },
    });
    expect(loaded.oauth).toEqual({
      homeOnly: { clientId: 'home-only-client' },
    });
  });

  it('keeps valid agent config when the project file is malformed', async () => {
    const runtime = runtimeWithConfigs({
      agent: {
        mcpServers: {
          docs: { url: 'https://docs.example.test/mcp', auth: 'oauth' },
        },
      },
      projectText: '{ not valid JSON',
    });

    await expect(readLocalMcpConfig(runtime, '/agent')).resolves.toEqual({
      config: {
        mcpServers: {
          docs: { url: 'https://docs.example.test/mcp', auth: 'oauth' },
        },
      },
      oauth: {},
      warnings: ['Skipped project MCP config: invalid JSON'],
    });
  });

  it('keeps valid agent config when the optional project file cannot be read', async () => {
    const runtime = runtimeWithConfigs({
      agent: {
        mcpServers: {
          docs: { url: 'https://docs.example.test/mcp', auth: 'oauth' },
        },
      },
      projectReadError: new Error('filesystem response with leaked-client-secret'),
    });

    const loaded = await readLocalMcpConfig(runtime, '/agent');

    expect(loaded.config.mcpServers).toEqual({
      docs: { url: 'https://docs.example.test/mcp', auth: 'oauth' },
    });
    expect(loaded.warnings).toEqual(['Skipped project MCP config: unable to read the file']);
    expect(loaded.warnings.join('\n')).not.toContain('leaked-client-secret');
  });

  it('uses an empty snapshot when both MCP files are absent', async () => {
    await expect(readLocalMcpConfig(runtimeWithConfigs({}), '/agent')).resolves.toEqual({
      config: { mcpServers: {} },
      oauth: {},
      warnings: [],
    });
  });

  it.each([
    [{ mcpServers: { bad: { command: 'npx', auth: 'oauth' } } }, 'unknown field'],
    [{ mcpServers: { bad: { url: 'https://mcp.test', auth: 'bearer' } } }, 'explicitly'],
    [{ mcpServers: { bad: { url: 'https://mcp.test', auth: 'oauth', oauth: { grantType: 'client_credentials' } } } }, 'authorization_code'],
    [{ mcpServers: { bad: { url: 'https://mcp.test', auth: 'oauth', oauth: { clientSecret: 'x', clientSecretEnv: 'X' } } } }, 'both'],
    [{ mcpServers: { bad: { url: 'https://mcp.test', auth: 'oauth', oauth: { clientSecretEnv: 'SECRET' } } } }, 'requires clientId'],
    [{ mcpServers: { bad: { url: 'https://mcp.test', auth: 'oauth', oauth: { clientId: 'id', clientSecretEnv: 'NOT VALID' } } } }, 'environment variable name'],
    [{ mcpServers: { bad: { url: 'https://mcp.test', auth: 'oauth', oauth: { authorizationParams: { state: 'bad' } } } } }, 'cannot override'],
  ])('rejects unsupported Felan-owned MCP config %#', (value, message) => {
    expect(() => validateLocalMcpConfig(value)).toThrow(message);
  });
});

interface RuntimeConfigFiles {
  readonly agent?: unknown;
  readonly project?: unknown;
  readonly projectText?: string;
  readonly projectReadError?: Error;
  readonly cwd?: string;
}

function runtimeWithConfigs(files: RuntimeConfigFiles): AgentRuntime {
  return {
    cwd: files.cwd ?? '/workspace',
    readAgentFile: async (path: string) => {
      expect(path).toBe('mcp.json');
      if (files.agent === undefined) throw missingFile();
      return encode(JSON.stringify(files.agent));
    },
    readFile: async (path: string, options?: { maxBytes?: number }) => {
      expect(path).toBe('.mcp.json');
      expect(options?.maxBytes).toBeGreaterThan(0);
      if (files.projectReadError !== undefined) throw files.projectReadError;
      if (files.projectText !== undefined) return encode(files.projectText);
      if (files.project === undefined) throw missingFile();
      return encode(JSON.stringify(files.project));
    },
  } as AgentRuntime;
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function missingFile(): Error {
  return Object.assign(new Error('missing'), { code: 'ENOENT' });
}
