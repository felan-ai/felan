import { createServer } from 'node:http';
import type {
  AuthOptions,
  OAuthClientProvider,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { OAuthError } from '@modelcontextprotocol/client';
import { SecretServiceError, type SecretRecord, type SecretsService, type ExtensionContext, type ExtensionUi } from '@felan-ai/agent-core';
import type { ResolvedMcpServer } from '@felan-ai/ext-mcp';
import { describe, expect, it, vi } from 'vitest';
import { createLocalMcpOAuthHost } from '../../../packages/ext-mcp/src/oauth-host.js';
import { canAuthorize, createAuthorizationPresenter } from '../../../packages/ext-mcp/src/authorization.js';
import { reserveOAuthCallback } from '../src/providers/mcp/callback-server.js';

describe('local MCP OAuth host', () => {
  it('keeps working credentials untouched when no local console can present the host form', async () => {
    const secrets = memorySecretStore();
    const write = vi.spyOn(secrets, 'write');
    const remove = vi.spyOn(secrets, 'remove');
    const ui = { canRequest: vi.fn(() => false), request: vi.fn() } as unknown as ExtensionUi;
    const runOAuth = vi.fn();
    const reserveCallback = vi.fn();
    const signal = new AbortController().signal;
    const session = await createLocalMcpOAuthHost('/agent', {}, {
      secrets, canAuthorize: () => canAuthorize(ui), presentAuthorization: createAuthorizationPresenter(ui), runOAuth, reserveCallback,
    }).createSession({ sessionId: 'remote', signal });
    const provider = await session.providerFor(oauthServer(), signal);
    await provider.saveClientInformation?.({ client_id: 'working-client', redirect_uris: ['http://127.0.0.1:3118/callback'] });
    await provider.saveTokens({ access_token: 'working-token', refresh_token: 'working-refresh', token_type: 'bearer' });
    write.mockClear(); remove.mockClear();
    await expect(session.authenticate(oauthServer(), { reason: 'explicit', signal, extensionContext: extensionContext('print') }))
      .resolves.toMatchObject({ status: 'unavailable' });
    expect(write).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    expect(runOAuth).not.toHaveBeenCalled(); expect(reserveCallback).not.toHaveBeenCalled(); expect(ui.request).not.toHaveBeenCalled();
    await expect(provider.tokens()).resolves.toMatchObject({ access_token: 'working-token', refresh_token: 'working-refresh' });
    await session.close();
  });

  it.each(['literal', 'environment'] as const)('supports %s confidential clients without persisting the configured client secret', async source => {
    const secrets = memorySecretStore();
    const write = vi.spyOn(secrets, 'write');
    const getEnvironmentVariable = vi.fn(() => 'client-secret-fixture');
    const signal = new AbortController().signal;
    const session = await createLocalMcpOAuthHost('/agent', { docs: { clientId: 'confidential-client',
      ...(source === 'literal' ? { clientSecret: 'client-secret-fixture' } : { clientSecretEnv: 'MCP_CLIENT_SECRET' }) } }, {
      secrets, canAuthorize: () => true, getEnvironmentVariable,
    }).createSession({ sessionId: 'confidential', signal });
    const provider = await session.providerFor(oauthServer(), signal);
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe('client_secret_post');
    await expect(provider.clientInformation()).resolves.toMatchObject({ client_id: 'confidential-client', client_secret: 'client-secret-fixture' });
    if (source === 'environment') expect(getEnvironmentVariable).toHaveBeenCalledWith('MCP_CLIENT_SECRET');
    else expect(getEnvironmentVariable).not.toHaveBeenCalled();
    expect(JSON.stringify(write.mock.calls)).not.toContain('client-secret-fixture');
    await session.close();
  });

  it('cancels before token exchange when the authorization dialog is dismissed', async () => {
    const context = extensionContext('tui'); const controller = new AbortController(); const release = vi.fn();
    const runOAuth = vi.fn(async (provider: OAuthClientProvider) => {
      await provider.redirectToAuthorization(new URL('https://auth.example.test/authorize')); return 'REDIRECT' as const;
    });
    const session = await createLocalMcpOAuthHost('/agent', {}, {
      canAuthorize: () => true, secrets: memorySecretStore(), runOAuth, presentAuthorization: async () => {},
      reserveCallback: async (redirectUri, _state, signal) => ({ redirectUri,
        wait: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), release }),
    }).createSession({ sessionId: 'presentation-dismissed', signal: controller.signal, });
    await expect(session.authenticate(oauthServer(), { reason: 'explicit', signal: controller.signal, extensionContext: context }))
      .resolves.toMatchObject({ status: 'cancelled' });
    expect(runOAuth).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce(); await session.close();
  });

  it('cancels token exchange when its presentation closes and refuses a late token write', async () => {
    let dismiss!: () => void; const presentation = new Promise<void>(resolve => { dismiss = resolve; });
    let entered!: () => void; const exchanging = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    const controller = new AbortController(); const context = extensionContext('tui');
    const session = await createLocalMcpOAuthHost('/agent', { docs: { clientId: 'fixture' } }, {
      canAuthorize: () => true, secrets: memorySecretStore(), presentAuthorization: () => presentation,
      reserveCallback: async redirectUri => ({ redirectUri, wait: async () => ({ code: 'fixture-code' }), release() {} }),
      runOAuth: async (provider, options) => {
        if (!options.authorizationCode) {
          await provider.clientInformation();
          await provider.redirectToAuthorization(new URL('https://auth.example.test/authorize')); return 'REDIRECT';
        }
        entered(); await held;
        await provider.saveTokens({ access_token: 'must-not-be-saved', token_type: 'bearer' });
        return 'AUTHORIZED';
      },
    }).createSession({ sessionId: 'presentation-exchange', signal: controller.signal, });
    const authenticating = session.authenticate(oauthServer(), { reason: 'explicit', signal: controller.signal, extensionContext: context });
    try {
      await exchanging; dismiss();
      await new Promise<void>(resolve => setImmediate(resolve)); release();
      await expect(authenticating).resolves.toMatchObject({ status: 'cancelled' });
      const provider = await session.providerFor(oauthServer(), controller.signal);
      await expect(provider.tokens()).resolves.toBeUndefined();
    } finally { release(); dismiss(); controller.abort(); await authenticating; await session.close(); }
  });

  it('uses an explicitly configured console in print mode and joins it after verified authorization', async () => {
    const stopped = vi.fn(); const context = extensionContext('print'); const controller = new AbortController();
    const session = await createLocalMcpOAuthHost('/agent', {}, {
      canAuthorize: () => true, secrets: memorySecretStore(),
      presentAuthorization: async ({ signal }) => {
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); stopped();
      },
      reserveCallback: async redirectUri => ({ redirectUri, wait: async () => ({ code: 'fixture-code' }), release() {} }),
      runOAuth: async (provider, options) => {
        if (options.authorizationCode) return 'AUTHORIZED';
        await provider.redirectToAuthorization(new URL('https://auth.example.test/authorize')); return 'REDIRECT';
      },
    }).createSession({ sessionId: 'presentation-success', signal: controller.signal, });
    await expect(session.authenticate(oauthServer(), { reason: 'explicit', signal: controller.signal, extensionContext: context }))
      .resolves.toEqual({ status: 'authenticated' });
    expect(stopped).toHaveBeenCalledOnce(); await session.close();
  });

  it('does not disguise an authorization-presentation failure as user cancellation', async () => {
    const context = extensionContext('tui'); const controller = new AbortController();
    const session = await createLocalMcpOAuthHost('/agent', {}, {
      canAuthorize: () => true, secrets: memorySecretStore(), presentAuthorization: async () => { throw new Error('presentation failed'); },
      reserveCallback: async (redirectUri, _state, signal) => ({ redirectUri,
        wait: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), release() {} }),
      runOAuth: async provider => { await provider.redirectToAuthorization(new URL('https://auth.example.test/authorize')); return 'REDIRECT'; },
    }).createSession({ sessionId: 'presentation-error', signal: controller.signal, });
    await expect(session.authenticate(oauthServer(), { reason: 'explicit', signal: controller.signal, extensionContext: context }))
      .rejects.toThrow('presentation failed');
    await session.close();
  });

  it('refuses authentication without an explicit local presentation host', async () => {
    const runOAuth = vi.fn(); const reserveCallback = vi.fn(); const context = extensionContext('tui');
    const controller = new AbortController();
    const session = await createLocalMcpOAuthHost('/agent', {}, { canAuthorize: () => true, secrets: memorySecretStore(), runOAuth, reserveCallback }).createSession({
      sessionId: 'no-presentation', signal: controller.signal, });
    await expect(session.authenticate(oauthServer(), { reason: 'explicit', signal: controller.signal, extensionContext: context }))
      .resolves.toMatchObject({ status: 'unavailable' });
    expect(runOAuth).not.toHaveBeenCalled(); expect(reserveCallback).not.toHaveBeenCalled(); await session.close();
  });

  it('uses an explicit presentation host in daemon mode and forwards cancellation', async () => {
    const controller = new AbortController();
    const context = { ...extensionContext('print'), hasUI: true } as ExtensionContext;
    const openUrl = vi.fn(async (_url: string, signal: AbortSignal) => { expect(signal.aborted).toBe(false); });
    const session = await createLocalMcpOAuthHost('/agent', {}, {
      canAuthorize: () => true, secrets: memorySecretStore(), presentAuthorization: authorizationPresenter(openUrl),
      reserveCallback: async redirectUri => ({ redirectUri, wait: async () => ({ code: 'fixture' }), release() {} }),
      runOAuth: async (provider, options) => {
        if (options.authorizationCode) return 'AUTHORIZED';
        await provider.redirectToAuthorization(new URL('https://auth.example.test/authorize')); return 'REDIRECT';
      },
    }).createSession({ sessionId: 'daemon-presentation', signal: controller.signal, });
    await expect(session.authenticate(oauthServer(), { reason: 'explicit', signal: controller.signal, extensionContext: context }))
      .resolves.toEqual({ status: 'authenticated' });
    expect(openUrl).toHaveBeenCalledWith('https://auth.example.test/authorize', expect.any(AbortSignal)); await session.close();
  });

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
      canAuthorize: () => true, secrets: memorySecretStore(),
      runOAuth,
      presentAuthorization: authorizationPresenter(openUrl),
      callbackTimeoutMs: 1_000,
      reserveCallback: reserveOAuthCallback,
    });
    const controller = new AbortController();
    const context = extensionContext('tui');
    const session = await host.createSession({
      sessionId: 'session-1',
      signal: controller.signal,
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

  it('replaces a cached dynamic client before explicit authentication', async () => {
    const secrets = memorySecretStore();
    const context = extensionContext('tui');
    const server = oauthServer();
    const seedController = new AbortController();
    const host = createLocalMcpOAuthHost('/agent', {}, { secrets, canAuthorize: () => true });
    const seedSession = await host.createSession({
      sessionId: 'seed-stale-client',
      signal: seedController.signal,
      });
    const seedProvider = await seedSession.providerFor(server, seedController.signal);
    await seedProvider.saveClientInformation?.({
      client_id: 'stale-dynamic-client',
      redirect_uris: ['http://127.0.0.1:3118/callback'],
      issuer: 'https://auth.example.test',
    }, { issuer: 'https://auth.example.test' });
    await seedSession.close();

    const runOAuth = vi.fn(async (provider: OAuthClientProvider, options: AuthOptions) => {
      if (!options.authorizationCode) {
        const existing = await provider.clientInformation({ issuer: 'https://auth.example.test' });
        const clientId = existing?.client_id ?? 'fresh-dynamic-client';
        if (!existing) {
          await provider.saveClientInformation?.({
            client_id: clientId,
            redirect_uris: ['http://127.0.0.1:3118/callback'],
            issuer: 'https://auth.example.test',
          }, { issuer: 'https://auth.example.test' });
        }
        await provider.redirectToAuthorization(new URL(
          `https://auth.example.test/authorize?client_id=${encodeURIComponent(clientId)}`,
        ));
        return 'REDIRECT' as const;
      }
      await provider.saveTokens({
        access_token: 'fresh-access-token',
        token_type: 'bearer',
        issuer: 'https://auth.example.test',
      }, { issuer: 'https://auth.example.test' });
      return 'AUTHORIZED' as const;
    });
    const controller = new AbortController();
    const session = await createLocalMcpOAuthHost('/agent', {}, {
      secrets, canAuthorize: () => true,
      runOAuth,
      presentAuthorization: authorizationPresenter(async (authorizationUrl) => {
        expect(new URL(authorizationUrl).searchParams.get('client_id')).toBe('fresh-dynamic-client');
      }),
      reserveCallback: async (redirectUri) => ({
        redirectUri,
        wait: async () => ({ code: 'oauth-code', iss: 'https://auth.example.test' }),
        release: () => {},
      }),
    }).createSession({
      sessionId: 'replace-stale-client',
      signal: controller.signal,
      });

    await expect(session.authenticate(server, {
      reason: 'explicit',
      signal: controller.signal,
      extensionContext: context,
    })).resolves.toEqual({ status: 'authenticated' });
    const provider = await session.providerFor(server, controller.signal);
    await expect(provider.clientInformation({ issuer: 'https://auth.example.test' }))
      .resolves.toMatchObject({ client_id: 'fresh-dynamic-client' });
    await session.close();
  });

  it('does not launch a callback flow without a configured authorization console', async () => {
    const runOAuth = vi.fn();
    const reserveCallback = vi.fn();
    const context = extensionContext('print');
    const controller = new AbortController();
    const session = await createLocalMcpOAuthHost('/agent', {}, {
      canAuthorize: () => true, secrets: memorySecretStore(),
      runOAuth,
      reserveCallback,
    }).createSession({
      sessionId: 'child',
      signal: controller.signal,
      });

    await expect(session.authenticate(oauthServer(), {
      reason: 'explicit',
      signal: controller.signal,
      extensionContext: context,
    })).resolves.toMatchObject({ status: 'unavailable', message: expect.stringContaining('configured host authorization console') });
    expect(runOAuth).not.toHaveBeenCalled();
    expect(reserveCallback).not.toHaveBeenCalled();
    await session.close();
  });

  it('propagates provider failures instead of treating every cancellation word as user cancellation', async () => {
    const controller = new AbortController();
    const session = await createLocalMcpOAuthHost('/agent', {}, {
      canAuthorize: () => true, secrets: memorySecretStore(),
      presentAuthorization: authorizationPresenter(async () => {}),
      reserveCallback: async (redirectUri) => ({
        redirectUri,
        wait: () => Promise.reject(new OAuthError('invalid_target', 'resource mismatch')),
        release: () => {},
      }),
      runOAuth: async (provider) => {
        await provider.redirectToAuthorization(new URL('https://auth.example.test/authorize'));
        return 'REDIRECT';
      },
    }).createSession({
      sessionId: 'provider-error',
      signal: controller.signal,
      });

    await expect(session.authenticate(oauthServer(), {
      reason: 'explicit',
      signal: controller.signal,
      extensionContext: extensionContext('tui'),
    })).rejects.toMatchObject({ code: 'invalid_target' });
    await session.close();
  });

  it('does not classify an unrelated error containing cancelled as cancellation', async () => {
    const controller = new AbortController();
    const session = await createLocalMcpOAuthHost('/agent', {}, {
      canAuthorize: () => true, secrets: memorySecretStore(),
      presentAuthorization: authorizationPresenter(async () => {}),
      reserveCallback: async (redirectUri) => ({
        redirectUri,
        wait: () => Promise.reject(new Error('request cancelled by upstream server')),
        release: () => {},
      }),
      runOAuth: async (provider) => {
        await provider.redirectToAuthorization(new URL('https://auth.example.test/authorize'));
        return 'REDIRECT';
      },
    }).createSession({
      sessionId: 'unrelated-error',
      signal: controller.signal,
      });

    await expect(session.authenticate(oauthServer(), {
      reason: 'explicit',
      signal: controller.signal,
      extensionContext: extensionContext('tui'),
    })).rejects.toThrow('request cancelled by upstream server');
    await session.close();
  });

  it('cancels an in-flight authorization before logout clears credentials', async () => {
    const context = extensionContext('tui');
    const controller = new AbortController();
    const openUrl = vi.fn(async () => {});
    const session = await createLocalMcpOAuthHost('/agent', {}, {
      canAuthorize: () => true, secrets: memorySecretStore(),
      presentAuthorization: authorizationPresenter(openUrl),
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
    const secrets = memorySecretStore();
    const firstController = new AbortController();
    const first = await createLocalMcpOAuthHost('/agent', {
      docs: { clientId: 'client-a' },
    }, { secrets, canAuthorize: () => true }).createSession({
      sessionId: 'first',
      signal: firstController.signal,
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
      docs: { clientId: 'client-b' },
    }, { secrets, canAuthorize: () => true }).createSession({
      sessionId: 'second',
      signal: secondController.signal,
      });
    const secondProvider = await second.providerFor(oauthServer(), secondController.signal);
    await expect(secondProvider.tokens({ issuer: 'https://auth.example.test' }))
      .resolves.toBeUndefined();
    await second.close();
  });

  it('retains the submitted redirect URI when registration omits it', async () => {
    const secrets = memorySecretStore();
    const controller = new AbortController();
    const session = await createLocalMcpOAuthHost('/agent', {}, { secrets, canAuthorize: () => true }).createSession({
      sessionId: 'registration-redirect',
      signal: controller.signal,
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
    const secrets = memorySecretStore();
    const firstController = new AbortController();
    const first = await createLocalMcpOAuthHost('/agent', {
      docs: { clientId: 'client-a', scope: 'read' },
    }, { secrets, canAuthorize: () => true }).createSession({
      sessionId: 'first-scope',
      signal: firstController.signal,
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
    }, { secrets, canAuthorize: () => true }).createSession({
      sessionId: 'second-scope',
      signal: secondController.signal,
      });
    const secondProvider = await second.providerFor(oauthServer(), secondController.signal);
    await expect(secondProvider.tokens({ issuer: 'https://auth.example.test' }))
      .resolves.toBeUndefined();
    await second.close();
  });

  it('rejects a stale token write after another session replaces a dynamic client', async () => {
    const secrets = memorySecretStore();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const host = createLocalMcpOAuthHost('/agent', {}, { secrets, canAuthorize: () => true });
    const [first, second] = await Promise.all([
      host.createSession({
        sessionId: 'dynamic-first',
        signal: firstController.signal,
        }),
      host.createSession({
        sessionId: 'dynamic-second',
        signal: secondController.signal,
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

function memorySecretStore(): SecretsService {
  const entries = new Map<string, SecretRecord>();
  let version = 0;
  return {
    read: async address => entries.get(JSON.stringify(address)),
    write: async (address, record) => {
      const key = JSON.stringify(address);
      if ((entries.get(key)?.version ?? null) !== record.expectedVersion) throw new SecretServiceError('conflict');
      const next = { value: record.value, version: String(++version) };
      entries.set(key, next);
      return next;
    },
    remove: async (address, expected) => {
      const key = JSON.stringify(address);
      if (entries.get(key)?.version !== expected) throw new SecretServiceError('conflict');
      entries.delete(key);
    },
  };
}

function authorizationPresenter(open: (url: string, signal: AbortSignal) => Promise<void>) {
  return async ({ url, signal }: { url: string; signal: AbortSignal }) => {
    await open(url, signal);
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
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
