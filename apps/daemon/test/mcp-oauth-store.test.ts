import type { StoredOAuthTokens } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import type { ResolvedMcpServer } from '@felan-ai/ext-mcp';
import {
  McpOAuthCredentialRepository,
  type McpOAuthSecretStore,
} from '../src/mcp/oauth-store.js';

describe('local MCP OAuth credential repository', () => {
  it('treats the keyring missing-entry null sentinel as no credentials', async () => {
    let stored: string | null = null;
    const secretStore: McpOAuthSecretStore = {
      read: async () => stored,
      write: async (_account, value) => {
        stored = value;
      },
      remove: async () => {
        stored = null;
      },
    };
    const repository = new McpOAuthCredentialRepository('/agent', secretStore);
    const server = oauthServer('docs', 'https://mcp.example.test/mcp');

    await expect(repository.read(server)).resolves.toBeUndefined();
    await expect(repository.update(server, () => ({
      version: 1,
      serverUrl: server.url,
      oauthProfile: '{}',
    }))).resolves.toBeUndefined();
    await expect(repository.read(server)).resolves.toMatchObject({ serverUrl: server.url });
  });

  it('stores secrets in the injected secure store and binds them to name, URL, and namespace', async () => {
    const secretStore = memorySecretStore();
    const repository = new McpOAuthCredentialRepository('/agent-a', secretStore);
    const server = oauthServer('docs', 'https://mcp.example.test/mcp');
    const tokens: StoredOAuthTokens = {
      access_token: 'access-secret',
      refresh_token: 'refresh-secret',
      token_type: 'bearer',
      issuer: 'https://auth.example.test',
    };
    await repository.update(server, () => ({
      version: 1,
      serverUrl: server.url,
      oauthProfile: '{}',
      tokens,
    }));

    await expect(repository.read(server)).resolves.toMatchObject({ tokens });
    await expect(repository.read(oauthServer('docs', 'https://changed.example.test/mcp')))
      .resolves.toBeUndefined();
    await expect(new McpOAuthCredentialRepository('/agent-b', secretStore).read(server))
      .resolves.toBeUndefined();

    await repository.remove(server);
    await expect(repository.read(server)).resolves.toBeUndefined();
  });

  it('serializes concurrent refresh-token updates for one credential', async () => {
    const secretStore = memorySecretStore();
    const repository = new McpOAuthCredentialRepository('/agent', secretStore);
    const server = oauthServer('docs', 'https://mcp.example.test/mcp');
    await Promise.all([
      repository.update(server, async (current) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          version: 1,
          serverUrl: server.url,
          oauthProfile: '{}',
          tokens: { access_token: `${current?.tokens?.access_token ?? ''}a`, token_type: 'bearer' },
        };
      }),
      repository.update(server, (current) => ({
        version: 1,
        serverUrl: server.url,
        oauthProfile: '{}',
        tokens: { access_token: `${current?.tokens?.access_token ?? ''}b`, token_type: 'bearer' },
      })),
    ]);

    await expect(repository.read(server)).resolves.toMatchObject({
      tokens: { access_token: 'ab' },
    });
  });
});

function memorySecretStore(): McpOAuthSecretStore {
  const entries = new Map<string, string>();
  return {
    read: async (account) => entries.get(account),
    write: async (account, value) => {
      entries.set(account, value);
    },
    remove: async (account) => {
      entries.delete(account);
    },
  };
}

function oauthServer(name: string, url: string): ResolvedMcpServer {
  return { name, url, auth: 'oauth', transport: 'auto' };
}
