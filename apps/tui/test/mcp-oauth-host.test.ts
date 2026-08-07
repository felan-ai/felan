import { createServer } from 'node:http';
import type {
  AuthOptions,
  OAuthClientProvider,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import type { ExtensionContext } from '@felan-ai/agent-core';
import type { ResolvedMcpServer } from '@felan-ai/ext-mcp';
import { describe, expect, it, vi } from 'vitest';
import { createLocalMcpOAuthHost } from '../src/mcp/oauth-host.js';
import type { McpOAuthSecretStore } from '../src/mcp/oauth-store.js';

describe('local MCP OAuth host', () => {
  it('runs authorization-code PKCE through the loopback callback and persists tokens', async () => {
    const port = await availablePort();
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const runOAuth = vi.fn(async (provider: OAuthClientProvider, options: AuthOptions) => {
      if (!options.authorizationCode) {
        await provider.saveCodeVerifier('pkce-verifier');
        await provider.saveDiscoveryState?.({ authorizationServerUrl: 'https://auth.example.test' });
        await provider.saveClientInformation?.({
          client_id: 'dynamic-client',
          redirect_uris: [redirectUri],
        });
        const state = await provider.state?.();
        await provider.redirectToAuthorization(new URL(
          `https://auth.example.test/authorize?client_id=test&state=${encodeURIComponent(String(state))}`,
        ));
        return 'REDIRECT' as const;
      }
      expect(options).toMatchObject({ authorizationCode: 'oauth-code', iss: 'https://auth.example.test' });
      expect(await provider.codeVerifier()).toBe('pkce-verifier');
      expect(await provider.discoveryState?.()).toEqual({
        authorizationServerUrl: 'https://auth.example.test',
      });
      await provider.saveTokens({
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        token_type: 'bearer',
        issuer: 'https://auth.example.test',
      });
      return 'AUTHORIZED' as const;
    });
    const openUrl = vi.fn(async (authorizationUrl: string) => {
      const url = new URL(authorizationUrl);
      expect(url.searchParams.get('access_type')).toBe('offline');
      const state = url.searchParams.get('state');
      const response = await fetch(
        `${redirectUri}?code=oauth-code&state=${encodeURIComponent(state!)}&iss=${encodeURIComponent('https://auth.example.test')}`,
      );
      expect(response.status).toBe(200);
    });
    const host = createLocalMcpOAuthHost('/agent', {
      docs: { redirectUri, authorizationParams: { access_type: 'offline' } },
    }, {
      secretStore: memorySecretStore(),
      runOAuth,
      openUrl,
      callbackTimeoutMs: 1_000,
    });
    const controller = new AbortController();
    const context = extensionContext('tui');
    const session = await host.createSession({
      sessionId: 'session-1',
      signal: controller.signal,
      extensionContext: context,
    });
    const server = oauthServer();

    await expect(session.authenticate(server, {
      reason: 'explicit',
      signal: controller.signal,
      extensionContext: context,
    })).resolves.toEqual({ status: 'authenticated' });
    expect(runOAuth).toHaveBeenCalledTimes(2);
    expect(openUrl).toHaveBeenCalledOnce();
    const provider = await session.providerFor(server, controller.signal);
    await expect(provider.tokens()).resolves.toMatchObject({
      access_token: 'access-secret',
      refresh_token: 'refresh-secret',
    } satisfies Partial<StoredOAuthTokens>);

    await session.logout(server, controller.signal);
    await expect(provider.tokens()).resolves.toBeUndefined();
    await session.close();
  });

  it('does not launch a browser or callback flow in print-mode subagents', async () => {
    const runOAuth = vi.fn();
    const openUrl = vi.fn();
    const context = extensionContext('print');
    const controller = new AbortController();
    const session = await createLocalMcpOAuthHost('/agent', {}, {
      secretStore: memorySecretStore(),
      runOAuth,
      openUrl,
    }).createSession({
      sessionId: 'child',
      signal: controller.signal,
      extensionContext: context,
    });

    await expect(session.authenticate(oauthServer(), {
      reason: 'connection-required',
      signal: controller.signal,
      extensionContext: context,
    })).resolves.toMatchObject({ status: 'unavailable', message: expect.stringContaining('root TUI') });
    expect(runOAuth).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
    await session.close();
  });

  it('cancels an in-flight authorization before logout clears credentials', async () => {
    const context = extensionContext('tui');
    const controller = new AbortController();
    const openUrl = vi.fn(async () => {});
    const session = await createLocalMcpOAuthHost('/agent', {}, {
      secretStore: memorySecretStore(),
      openUrl,
      reserveCallback: async (redirectUri, _state, signal) => ({
        redirectUri,
        wait: () => new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
        release: () => {},
      }),
      runOAuth: async (provider) => {
        await provider.redirectToAuthorization(new URL('https://auth.example.test/authorize'));
        return 'REDIRECT';
      },
    }).createSession({
      sessionId: 'logout-race',
      signal: controller.signal,
      extensionContext: context,
    });
    const server = oauthServer();
    const authentication = session.authenticate(server, {
      reason: 'explicit',
      signal: controller.signal,
      extensionContext: context,
    });
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledOnce());

    await session.logout(server, controller.signal);
    await expect(authentication).resolves.toMatchObject({ status: 'cancelled' });
    await session.close();
  });

  it('does not reuse tokens after the configured OAuth client changes', async () => {
    const secretStore = memorySecretStore();
    const context = extensionContext('tui');
    const firstController = new AbortController();
    const first = await createLocalMcpOAuthHost('/agent', {
      docs: { clientId: 'client-a', clientSecret: 'secret-a' },
    }, { secretStore }).createSession({
      sessionId: 'first',
      signal: firstController.signal,
      extensionContext: context,
    });
    const firstProvider = await first.providerFor(oauthServer(), firstController.signal);
    await firstProvider.clientInformation({ issuer: 'https://auth.example.test' });
    await firstProvider.saveTokens({
      access_token: 'old-access',
      refresh_token: 'old-refresh',
      token_type: 'bearer',
      issuer: 'https://auth.example.test',
    }, { issuer: 'https://auth.example.test' });
    await first.close();

    const secondController = new AbortController();
    const second = await createLocalMcpOAuthHost('/agent', {
      docs: { clientId: 'client-b', clientSecret: 'secret-b' },
    }, { secretStore }).createSession({
      sessionId: 'second',
      signal: secondController.signal,
      extensionContext: context,
    });
    const secondProvider = await second.providerFor(oauthServer(), secondController.signal);
    await expect(secondProvider.tokens({ issuer: 'https://auth.example.test' }))
      .resolves.toBeUndefined();
    await second.close();
  });

  it('retains the submitted redirect URI when registration omits it', async () => {
    const secretStore = memorySecretStore();
    const context = extensionContext('tui');
    const controller = new AbortController();
    const session = await createLocalMcpOAuthHost('/agent', {}, { secretStore }).createSession({
      sessionId: 'registration-redirect',
      signal: controller.signal,
      extensionContext: context,
    });
    const provider = await session.providerFor(oauthServer(), controller.signal);

    await provider.saveClientInformation?.({
      client_id: 'dynamic-client',
      issuer: 'https://auth.example.test',
    }, { issuer: 'https://auth.example.test' });

    await expect(provider.clientInformation({ issuer: 'https://auth.example.test' }))
      .resolves.toMatchObject({
        client_id: 'dynamic-client',
        redirect_uris: ['http://127.0.0.1:3118/callback'],
      });
    await session.close();
  });

  it('does not reuse tokens after the requested OAuth scope changes', async () => {
    const secretStore = memorySecretStore();
    const context = extensionContext('tui');
    const firstController = new AbortController();
    const first = await createLocalMcpOAuthHost('/agent', {
      docs: { clientId: 'client-a', scope: 'read' },
    }, { secretStore }).createSession({
      sessionId: 'first-scope',
      signal: firstController.signal,
      extensionContext: context,
    });
    const firstProvider = await first.providerFor(oauthServer(), firstController.signal);
    await firstProvider.clientInformation({ issuer: 'https://auth.example.test' });
    await firstProvider.saveTokens({
      access_token: 'read-token',
      token_type: 'bearer',
      issuer: 'https://auth.example.test',
    }, { issuer: 'https://auth.example.test' });
    await first.close();

    const secondController = new AbortController();
    const second = await createLocalMcpOAuthHost('/agent', {
      docs: { clientId: 'client-a', scope: 'write' },
    }, { secretStore }).createSession({
      sessionId: 'second-scope',
      signal: secondController.signal,
      extensionContext: context,
    });
    const secondProvider = await second.providerFor(oauthServer(), secondController.signal);
    await expect(secondProvider.tokens({ issuer: 'https://auth.example.test' }))
      .resolves.toBeUndefined();
    await second.close();
  });

  it('rejects a stale token write after another session replaces a dynamic client', async () => {
    const secretStore = memorySecretStore();
    const context = extensionContext('tui');
    const firstController = new AbortController();
    const secondController = new AbortController();
    const host = createLocalMcpOAuthHost('/agent', {}, { secretStore });
    const [first, second] = await Promise.all([
      host.createSession({
        sessionId: 'dynamic-first',
        signal: firstController.signal,
        extensionContext: context,
      }),
      host.createSession({
        sessionId: 'dynamic-second',
        signal: secondController.signal,
        extensionContext: context,
      }),
    ]);
    const [firstProvider, secondProvider] = await Promise.all([
      first.providerFor(oauthServer(), firstController.signal),
      second.providerFor(oauthServer(), secondController.signal),
    ]);
    const redirectUris = ['http://127.0.0.1:3118/callback'];
    await firstProvider.saveClientInformation?.({
      client_id: 'dynamic-a',
      redirect_uris: redirectUris,
    });
    await secondProvider.saveClientInformation?.({
      client_id: 'dynamic-b',
      redirect_uris: redirectUris,
    });

    await expect(firstProvider.saveTokens({
      access_token: 'stale-token',
      token_type: 'bearer',
    })).rejects.toThrow('changed concurrently');
    await secondProvider.saveTokens({ access_token: 'current-token', token_type: 'bearer' });
    await expect(secondProvider.tokens()).resolves.toMatchObject({ access_token: 'current-token' });

    await Promise.all([first.close(), second.close()]);
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

function extensionContext(mode: 'tui' | 'print'): ExtensionContext {
  return {
    mode,
    hasUI: mode === 'tui',
    ui: { notify: vi.fn() },
    signal: new AbortController().signal,
    sessionManager: { getSessionId: () => 'session-1' },
  } as unknown as ExtensionContext;
}

function oauthServer(): ResolvedMcpServer {
  return {
    name: 'docs',
    url: 'https://mcp.example.test/mcp',
    auth: 'oauth',
    transport: 'auto',
  };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
