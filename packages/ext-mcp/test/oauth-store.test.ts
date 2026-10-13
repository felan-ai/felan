import type { StoredOAuthTokens } from '@modelcontextprotocol/client';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { SecretServiceError, type SecretRecord, type SecretsService } from '@felan-ai/agent-core';
import type { ResolvedMcpServer } from '@felan-ai/ext-mcp';
import {
  McpOAuthCredentialRepository,
} from '../src/oauth-store.js';

describe('local MCP OAuth credential repository', () => {
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

  it('uses versioned shared Secrets and a namespaced credential address', async () => {
    const shared = sharedSecrets();
    const repository = new McpOAuthCredentialRepository('/agent', shared.service);
    const server = oauthServer('docs', 'https://mcp.example.test/mcp');
    const credentials = { version: 1 as const, serverUrl: server.url, oauthProfile: '{}',
      tokens: { access_token: 'shared-fixture', token_type: 'bearer' } };
    await repository.update(server, () => credentials);
    const address = shared.service.write.mock.calls[0]![0];
    expect(address).toMatchObject({ namespace: 'mcp.oauth', key: expect.stringMatching(/^sha256-[a-f0-9]{64}$/u) });
    expect([...shared.entries.values()][0]?.value).toBe(JSON.stringify(credentials));
    await expect(repository.read(server)).resolves.toEqual(credentials);
    await expect(repository.read(oauthServer('docs', 'https://other.example.test/mcp'))).resolves.toBeUndefined();
    await expect(new McpOAuthCredentialRepository('/other-agent', shared.service).read(server)).resolves.toBeUndefined();
    await repository.remove(server);
    await repository.remove(server);
    expect(shared.entries.size).toBe(0);
  });

  it('rejects a conflicting external credential write without replaying the update callback', async () => {
    const shared = sharedSecrets();
    const repository = new McpOAuthCredentialRepository('/agent', shared.service);
    const server = oauthServer('docs', 'https://mcp.example.test/mcp');
    await repository.update(server, () => ({ version: 1, serverUrl: server.url, oauthProfile: '{}' }));
    const address = shared.service.write.mock.calls[0]![0];
    const update = vi.fn(async () => {
      const record = await shared.service.read(address);
      await shared.service.write(address, { value: 'external-authority', expectedVersion: record!.version });
      return { version: 1 as const, serverUrl: server.url, oauthProfile: '{}' };
    });
    await expect(repository.update(server, update)).rejects.toMatchObject({ code: 'conflict' });
    expect(update).toHaveBeenCalledOnce();
    expect((await shared.service.read(address))?.value).toBe('external-authority');
  });

  it('does not publish a cancelled credential update', async () => {
    const shared = sharedSecrets();
    const repository = new McpOAuthCredentialRepository('/agent', shared.service);
    const controller = new AbortController();
    const server = oauthServer('docs', 'https://mcp.example.test/mcp');
    await expect(repository.update(server, () => {
      controller.abort();
      return { version: 1 as const, serverUrl: server.url, oauthProfile: '{}' };
    }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(shared.service.write).not.toHaveBeenCalled();
  });

  it('keeps malformed credentials out of the entire parse error', async () => {
    const sensitive = 'private-credential-sentinel';
    const malformed = `{"tokens":${sensitive}}`;
    const shared = sharedSecrets();
    shared.service.read.mockResolvedValue({ value: malformed, version: '1' });
    const repository = new McpOAuthCredentialRepository('/agent', shared.service);
    const server = oauthServer('docs', 'https://mcp.example.test/mcp');
    const update = vi.fn();
    for (const operation of [() => repository.read(server), () => repository.update(server, update)]) {
      const error = await operation().catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ message: 'Stored MCP OAuth credentials are invalid' });
      expect(error).not.toHaveProperty('cause');
      expect(inspect(error, { depth: 10, showHidden: true })).not.toContain(sensitive);
    }
    expect(update).not.toHaveBeenCalled();
    expect(shared.service.write).not.toHaveBeenCalled();
  });
});

function sharedSecrets() {
  const entries = new Map<string, SecretRecord>();
  let version = 0;
  const service = {
    read: vi.fn<SecretsService['read']>(async address => entries.get(JSON.stringify(address))),
    write: vi.fn<SecretsService['write']>(async (address, record) => {
      const key = JSON.stringify(address);
      if ((entries.get(key)?.version ?? null) !== record.expectedVersion) throw new SecretServiceError('conflict');
      const next = { value: record.value, version: String(++version) };
      entries.set(key, next);
      return next;
    }),
    remove: vi.fn<SecretsService['remove']>(async (address, expected) => {
      const key = JSON.stringify(address);
      if (entries.get(key)?.version !== expected) throw new SecretServiceError('conflict');
      entries.delete(key);
    }),
  } satisfies SecretsService;
  return { entries, service };
}

function memorySecretStore(): SecretsService { return sharedSecrets().service; }

function oauthServer(name: string, url: string): ResolvedMcpServer {
  return { name, url, auth: 'oauth', transport: 'auto' };
}
