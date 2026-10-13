import { randomBytes } from 'node:crypto';
import {
  auth,
  OAuthError,
  type AuthOptions,
  type AuthResult,
  type FetchLike,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import type {
  McpOAuthAuthenticationContext,
  McpOAuthAuthenticationOutcome,
  McpOAuthHost,
  McpOAuthSession,
  McpOAuthSessionContext,
  ResolvedMcpServer,
} from './contracts.js';
import type { SecretsService } from '@felan-ai/agent-core';
import type { McpOAuthCallbackService, OAuthCallbackReservation } from './service.js';
import type { LocalMcpOAuthConfig } from './local-config.js';
import {
  McpOAuthCredentialRepository,
  type StoredMcpOAuthCredentials,
} from './oauth-store.js';

const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:3118/callback';
const DEFAULT_CLIENT_NAME = 'Felan Code';
const DEFAULT_CLIENT_URI = 'https://github.com/felan-ai/felan';
const DEFAULT_OAUTH_REQUEST_TIMEOUT_MS = 30_000;

type RunOAuth = (
  provider: OAuthClientProvider,
  options: AuthOptions,
) => Promise<AuthResult>;

interface ActiveAuthentication {
  readonly controller: AbortController;
  readonly promise: Promise<McpOAuthAuthenticationOutcome>;
}

export type LocalMcpOAuthPresenter = (request: { server: string; url: string; signal: AbortSignal }) => Promise<void>;

export interface LocalMcpOAuthDependencies {
  readonly secrets: SecretsService;
  readonly canAuthorize: () => boolean;
  readonly getEnvironmentVariable?: (name: string) => string | undefined;
  readonly runOAuth?: RunOAuth;
  readonly presentAuthorization?: LocalMcpOAuthPresenter;
  readonly reserveCallback?: McpOAuthCallbackService['reserve'];
  readonly callbackTimeoutMs?: number;
  readonly fetchFn?: FetchLike;
}

export function createLocalMcpOAuthHost(
  namespace: string,
  configs: Readonly<Record<string, LocalMcpOAuthConfig>>,
  dependencies: LocalMcpOAuthDependencies,
): McpOAuthHost {
  const repository = new McpOAuthCredentialRepository(namespace, dependencies.secrets);
  return {
    async createSession(context) {
      return new LocalMcpOAuthSession(context, configs, repository, dependencies);
    },
  };
}

class LocalMcpOAuthSession implements McpOAuthSession {
  readonly #context: McpOAuthSessionContext;
  readonly #configs: Readonly<Record<string, LocalMcpOAuthConfig>>;
  readonly #repository: McpOAuthCredentialRepository;
  readonly #dependencies: LocalMcpOAuthDependencies;
  readonly #controller = new AbortController();
  readonly #providers = new Map<string, LocalOAuthProvider>();
  readonly #authentications = new Map<string, ActiveAuthentication>();
  #closed = false;

  constructor(
    context: McpOAuthSessionContext,
    configs: Readonly<Record<string, LocalMcpOAuthConfig>>,
    repository: McpOAuthCredentialRepository,
    dependencies: LocalMcpOAuthDependencies,
  ) {
    this.#context = context;
    this.#configs = configs;
    this.#repository = repository;
    this.#dependencies = dependencies;
  }

  async providerFor(server: ResolvedMcpServer, signal: AbortSignal): Promise<OAuthClientProvider> {
    this.#assertOpen();
    combineSignals(this.#context.signal, this.#controller.signal, signal).throwIfAborted();
    let provider = this.#providers.get(server.name);
    if (!provider) {
      provider = new LocalOAuthProvider(
        server,
        this.#configs[server.name] ?? {},
        this.#repository,
        combineSignals(this.#context.signal, this.#controller.signal),
        this.#dependencies.fetchFn,
        this.#dependencies.getEnvironmentVariable,
      );
      this.#providers.set(server.name, provider);
    } else if (provider.server.url !== server.url) {
      throw new Error(`MCP server URL changed during the OAuth session: ${server.name}`);
    }
    return provider;
  }

  async authenticate(
    server: ResolvedMcpServer,
    context: McpOAuthAuthenticationContext,
  ): Promise<McpOAuthAuthenticationOutcome> {
    this.#assertOpen();
    const presentAuthorization = this.#dependencies.presentAuthorization;
    if (!presentAuthorization || !this.#dependencies.reserveCallback || !this.#dependencies.canAuthorize()) {
      return {
        status: 'unavailable',
        message: `OAuth authentication for ${server.name} requires a configured host authorization console.`,
      };
    }
    const existing = this.#authentications.get(server.name);
    if (existing) return existing.promise;

    const controller = new AbortController();
    const operation = this.#authenticateInteractive(server, {
      ...context,
      signal: combineSignals(context.signal, controller.signal),
    }, presentAuthorization).finally(() => {
      if (this.#authentications.get(server.name)?.promise === operation) {
        this.#authentications.delete(server.name);
      }
    });
    this.#authentications.set(server.name, { controller, promise: operation });
    return operation;
  }

  async logout(server: ResolvedMcpServer, signal: AbortSignal): Promise<void> {
    this.#assertOpen();
    const combined = combineSignals(this.#context.signal, this.#controller.signal, signal);
    const active = this.#authentications.get(server.name);
    if (active) {
      active.controller.abort(new Error(`OAuth authentication for ${server.name} was cancelled by logout`));
      await active.promise.catch(() => {});
    }
    combined.throwIfAborted();
    await this.#repository.remove(server, combined);
    this.#providers.get(server.name)?.clearTransientFlow();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#controller.abort(new Error('Local MCP OAuth session closed'));
    await Promise.allSettled([...this.#authentications.values()].map(({ promise }) => promise));
    for (const provider of this.#providers.values()) provider.deactivate();
    this.#providers.clear();
  }

  async #authenticateInteractive(
    server: ResolvedMcpServer,
    context: McpOAuthAuthenticationContext,
    presentAuthorization: LocalMcpOAuthPresenter,
  ): Promise<McpOAuthAuthenticationOutcome> {
    const dismissed = new AbortController();
    const presentationEnded = new AbortController();
    const signal = combineSignals(
      this.#context.signal,
      this.#controller.signal,
      context.signal,
      dismissed.signal,
    );
    const provider = await this.providerFor(server, signal) as LocalOAuthProvider;
    if (!this.#configs[server.name]?.clientId) {
      await provider.invalidateCredentials('all');
    }
    provider.beginFlow(signal);
    let callback: OAuthCallbackReservation | undefined;
    let presentation: Promise<void> | undefined;
    let finished = false;
    let presentationFailed = false;
    let presentationError: unknown;
    try {
      callback = await this.#dependencies.reserveCallback!(
        provider.redirectUrl.toString(),
        provider.currentState,
        signal,
        this.#dependencies.callbackTimeoutMs,
      );
      const runOAuth = this.#dependencies.runOAuth ?? auth;
      const initial = await runOAuth(provider, provider.authOptions());
      signal.throwIfAborted();
      if (initial === 'AUTHORIZED') return { status: 'authenticated' };

      const authorizationUrl = provider.authorizationUrl;
      if (!authorizationUrl) throw new Error('OAuth provider did not supply an authorization URL');
      presentation = Promise.resolve().then(() => presentAuthorization({ server: server.name, url: authorizationUrl,
        signal: combineSignals(signal, presentationEnded.signal) })).then(() => {
        if (!finished) dismissed.abort();
      }, error => {
        if (!finished) {
          if (!signal.aborted) { presentationFailed = true; presentationError = error; }
          dismissed.abort(error);
        }
      });
      const result = await Promise.race([
        callback.wait().then(value => ({ kind: 'callback' as const, value })),
        presentation.then(() => ({ kind: 'dismissed' as const })),
      ]);
      if (presentationFailed) throw presentationError;
      if (result.kind === 'dismissed') return { status: 'cancelled', message: `OAuth authentication for ${server.name} was cancelled.` };
      signal.throwIfAborted();
      const completed = await runOAuth(provider, provider.authOptions({
        authorizationCode: result.value.code,
        ...(result.value.iss === undefined ? {} : { iss: result.value.iss }),
      }));
      signal.throwIfAborted();
      if (completed !== 'AUTHORIZED') throw new Error('OAuth token exchange did not complete');
      return { status: 'authenticated' };
    } catch (error) {
      if (presentationFailed) throw presentationError;
      if (signal.aborted) {
        return { status: 'cancelled', message: `OAuth authentication for ${server.name} was cancelled.` };
      }
      if (error instanceof OAuthError && error.code === 'access_denied') {
        return { status: 'cancelled', message: `OAuth authentication for ${server.name} was cancelled.` };
      }
      throw error;
    } finally {
      finished = true;
      presentationEnded.abort();
      await presentation;
      callback?.release();
      provider.clearTransientFlow();
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('Local MCP OAuth session is closed');
  }
}

export class LocalOAuthProvider implements OAuthClientProvider {
  readonly server: ResolvedMcpServer;
  readonly #config: LocalMcpOAuthConfig;
  readonly #repository: McpOAuthCredentialRepository;
  readonly #signal: AbortSignal;
  readonly #redirectUrl: URL;
  readonly #oauthProfile: string;
  readonly #fetchFn: FetchLike;
  readonly #getEnvironmentVariable: ((name: string) => string | undefined) | undefined;
  #active = true;
  #state = generateState();
  #codeVerifier: string | undefined;
  #authorizationUrl: string | undefined;
  #discoveryState: OAuthDiscoveryState | undefined;
  #flowSignal: AbortSignal | undefined;
  #activeClientId: string | undefined;

  constructor(
    server: ResolvedMcpServer,
    config: LocalMcpOAuthConfig,
    repository: McpOAuthCredentialRepository,
    signal: AbortSignal,
    fetchFn: FetchLike = fetch,
    getEnvironmentVariable?: (name: string) => string | undefined,
  ) {
    this.server = server;
    this.#config = config;
    this.#repository = repository;
    this.#signal = signal;
    this.#redirectUrl = validateRedirectUrl(config.redirectUri ?? DEFAULT_REDIRECT_URI);
    this.#oauthProfile = oauthProfile(config, this.#redirectUrl);
    this.#fetchFn = fetchFn;
    this.#getEnvironmentVariable = getEnvironmentVariable;
  }

  get redirectUrl(): URL {
    return new URL(this.#redirectUrl);
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.#redirectUrl.toString()],
      client_name: this.#config.clientName ?? DEFAULT_CLIENT_NAME,
      client_uri: this.#config.clientUri ?? DEFAULT_CLIENT_URI,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: this.#config.clientSecret !== undefined || this.#config.clientSecretEnv !== undefined ? 'client_secret_post' : 'none',
      ...(this.#config.scope === undefined ? {} : { scope: this.#config.scope }),
    };
  }

  get currentState(): string {
    return this.#state;
  }

  get authorizationUrl(): string | undefined {
    return this.#authorizationUrl;
  }

  state(): string {
    this.#assertActive();
    return this.#state;
  }

  async clientInformation(
    context?: OAuthClientInformationContext,
  ): Promise<StoredOAuthClientInformation | undefined> {
    this.#assertActive();
    if (this.#config.clientId) {
      const information: StoredOAuthClientInformation = {
        client_id: this.#config.clientId,
        ...(this.#clientSecret === undefined ? {} : { client_secret: this.#clientSecret }),
        ...(context?.issuer === undefined ? {} : { issuer: context.issuer }),
      };
      await this.#repository.update(this.server, (current) => ({
        version: 1,
        serverUrl: this.server.url,
        oauthProfile: this.#oauthProfile,
        clientInformation: {
          client_id: information.client_id,
          ...(information.issuer === undefined ? {} : { issuer: information.issuer }),
        },
        ...(canReuseConfiguredTokens(
          current,
          information.client_id,
          context?.issuer,
          this.#oauthProfile,
        )
          ? { tokens: current!.tokens }
          : {}),
      }), this.#operationSignal);
      this.#activeClientId = information.client_id;
      return information;
    }
    const stored = await this.#repository.read(this.server, this.#operationSignal);
    if (stored?.oauthProfile !== this.#oauthProfile) {
      this.#activeClientId = undefined;
      return undefined;
    }
    assertIssuer(stored?.clientInformation?.issuer, context?.issuer, this.server.name);
    if (stored?.clientInformation && !hasCurrentRedirectUri(stored.clientInformation, this.#redirectUrl)) {
      await this.#repository.remove(this.server, this.#operationSignal);
      this.#activeClientId = undefined;
      return undefined;
    }
    this.#activeClientId = stored?.clientInformation?.client_id;
    return stored?.clientInformation;
  }

  async saveClientInformation(
    information: StoredOAuthClientInformation,
    context?: OAuthClientInformationContext,
  ): Promise<void> {
    this.#assertActive();
    assertIssuer(information.issuer, context?.issuer, this.server.name);
    const storedInformation: StoredOAuthClientInformation = this.#config.clientId
      ? {
        client_id: this.#config.clientId,
        ...(information.issuer === undefined ? {} : { issuer: information.issuer }),
      }
      : 'redirect_uris' in information && Array.isArray(information.redirect_uris)
        ? information
        : { ...information, redirect_uris: [this.#redirectUrl.toString()] };
    if (!this.#config.clientId && !hasCurrentRedirectUri(storedInformation, this.#redirectUrl)) {
      throw new Error(`OAuth dynamic client registration returned a mismatched redirect URI for ${this.server.name}`);
    }
    await this.#repository.update(this.server, (current) => ({
      version: 1,
      serverUrl: this.server.url,
      oauthProfile: this.#oauthProfile,
      ...(canReuseClientTokens(current, storedInformation, this.#oauthProfile)
        ? { tokens: current!.tokens }
        : {}),
      clientInformation: storedInformation,
    }), this.#operationSignal);
    this.#activeClientId = storedInformation.client_id;
  }

  async tokens(context?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    this.#assertActive();
    const stored = await this.#repository.read(this.server, this.#operationSignal);
    if (stored?.oauthProfile !== this.#oauthProfile) {
      this.#activeClientId = undefined;
      return undefined;
    }
    assertIssuer(stored?.tokens?.issuer, context?.issuer, this.server.name);
    assertIssuer(stored?.clientInformation?.issuer, context?.issuer, this.server.name);
    if (!stored?.tokens) return undefined;
    if (this.#config.clientId) {
      if (stored.clientInformation?.client_id !== this.#config.clientId) return undefined;
      this.#activeClientId = this.#config.clientId;
      return stored.tokens;
    }
    if (!stored.clientInformation || !hasCurrentRedirectUri(stored.clientInformation, this.#redirectUrl)) {
      return undefined;
    }
    this.#activeClientId = stored.clientInformation.client_id;
    return stored.tokens;
  }

  async saveTokens(tokens: StoredOAuthTokens, context?: OAuthClientInformationContext): Promise<void> {
    this.#assertActive();
    assertIssuer(tokens.issuer, context?.issuer, this.server.name);
    await this.#repository.update(this.server, (current) => {
      const expectedClientId = this.#config.clientId ?? this.#activeClientId;
      if (
        expectedClientId === undefined
        || current?.oauthProfile !== this.#oauthProfile
        || current.clientInformation?.client_id !== expectedClientId
      ) {
        throw new Error(`OAuth client configuration changed concurrently for ${this.server.name}; retry authentication`);
      }
      return {
        version: 1,
        serverUrl: this.server.url,
        oauthProfile: this.#oauthProfile,
        ...(this.#config.clientId
          ? {
            clientInformation: {
              client_id: this.#config.clientId,
              ...(tokens.issuer === undefined ? {} : { issuer: tokens.issuer }),
            },
          }
          : { clientInformation: current!.clientInformation }),
        tokens,
      };
    }, this.#operationSignal);
  }

  redirectToAuthorization(url: URL): void {
    this.#assertActive();
    const authorizationUrl = validateAuthorizationUrl(url);
    for (const [key, value] of Object.entries(this.#config.authorizationParams ?? {})) {
      if (authorizationUrl.searchParams.has(key)) {
        throw new Error(`OAuth authorization parameter ${key} is already set by the authorization server`);
      }
      authorizationUrl.searchParams.set(key, value);
    }
    this.#authorizationUrl = authorizationUrl.toString();
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.#assertActive();
    this.#codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    this.#assertActive();
    if (!this.#codeVerifier) throw new Error('OAuth PKCE code verifier is unavailable');
    return this.#codeVerifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.#assertActive();
    this.#discoveryState = structuredClone(state);
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    this.#assertActive();
    return this.#discoveryState === undefined
      ? undefined
      : structuredClone(this.#discoveryState);
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    this.#assertActive();
    if (scope === 'verifier') {
      this.#codeVerifier = undefined;
      return;
    }
    if (scope === 'discovery') {
      this.#discoveryState = undefined;
      return;
    }
    if (scope === 'all') {
      await this.#repository.remove(this.server, this.#operationSignal);
      this.#activeClientId = undefined;
      this.clearTransientFlow();
      return;
    }
    if (scope === 'client') this.#activeClientId = undefined;
    await this.#repository.update(this.server, (current) => withoutCredential(current, scope), this.#operationSignal);
  }

  beginFlow(signal?: AbortSignal): void {
    this.#assertActive();
    this.#flowSignal = signal ? combineSignals(this.#signal, signal) : undefined;
    this.#state = generateState();
    this.#codeVerifier = undefined;
    this.#authorizationUrl = undefined;
    this.#discoveryState = undefined;
  }

  clearTransientFlow(): void {
    this.#flowSignal = undefined;
    this.#codeVerifier = undefined;
    this.#authorizationUrl = undefined;
    this.#discoveryState = undefined;
  }

  deactivate(): void {
    this.#active = false;
    this.clearTransientFlow();
  }

  authOptions(extra: Partial<AuthOptions> = {}): AuthOptions {
    return {
      serverUrl: this.server.url,
      ...(this.#config.scope === undefined ? {} : { scope: this.#config.scope }),
      fetchFn: this.#boundedFetch(),
      ...extra,
    };
  }

  get #clientSecret(): string | undefined {
    if (this.#config.clientSecret !== undefined) return this.#config.clientSecret;
    if (this.#config.clientSecretEnv === undefined) return undefined;
    const value = this.#getEnvironmentVariable?.(this.#config.clientSecretEnv);
    if (!value) throw new Error(`OAuth client secret environment variable is unavailable for ${this.server.name}`);
    return value;
  }

  get #operationSignal(): AbortSignal { return this.#flowSignal ?? this.#signal; }

  #assertActive(): void {
    if (!this.#active) throw new Error('OAuth provider is no longer active');
    this.#operationSignal.throwIfAborted();
  }

  #boundedFetch(): FetchLike {
    return (input, init) => {
      const timeout = AbortSignal.timeout(
        this.server.requestTimeoutMs ?? DEFAULT_OAUTH_REQUEST_TIMEOUT_MS,
      );
      const initSignal = init?.signal ?? undefined;
      const signal = combineSignals(
        this.#signal,
        ...(this.#flowSignal === undefined ? [] : [this.#flowSignal]),
        ...(initSignal === undefined ? [] : [initSignal]),
        timeout,
      );
      return this.#fetchFn(input, { ...init, signal });
    };
  }
}

function withoutCredential(
  current: StoredMcpOAuthCredentials | undefined,
  scope: 'client' | 'tokens',
): StoredMcpOAuthCredentials | undefined {
  if (!current) return undefined;
  if (scope === 'client' && current.tokens) {
    return {
      version: 1,
      serverUrl: current.serverUrl,
      oauthProfile: current.oauthProfile,
      tokens: current.tokens,
    };
  }
  if (scope === 'tokens' && current.clientInformation) {
    return {
      version: 1,
      serverUrl: current.serverUrl,
      oauthProfile: current.oauthProfile,
      clientInformation: current.clientInformation,
    };
  }
  return undefined;
}

function canReuseConfiguredTokens(
  current: StoredMcpOAuthCredentials | undefined,
  clientId: string,
  issuer: string | undefined,
  oauthProfileValue: string,
): boolean {
  if (
    !current?.tokens
    || current.clientInformation?.client_id !== clientId
    || current.oauthProfile !== oauthProfileValue
  ) return false;
  if (issuer === undefined) return true;
  const boundIssuers = [current.clientInformation.issuer, current.tokens.issuer]
    .filter((value): value is string => value !== undefined);
  return boundIssuers.every((value) => issuersMatch(value, issuer));
}

function canReuseClientTokens(
  current: StoredMcpOAuthCredentials | undefined,
  information: StoredOAuthClientInformation,
  oauthProfileValue: string,
): boolean {
  if (
    !current?.tokens
    || current.clientInformation?.client_id !== information.client_id
    || current.oauthProfile !== oauthProfileValue
  ) return false;
  const requestedIssuer = information.issuer;
  if (requestedIssuer === undefined) return true;
  return [current.clientInformation.issuer, current.tokens.issuer]
    .filter((value): value is string => value !== undefined)
    .every((value) => issuersMatch(value, requestedIssuer));
}

function hasCurrentRedirectUri(
  information: StoredOAuthClientInformation,
  redirectUrl: URL,
): boolean {
  return 'redirect_uris' in information
    && Array.isArray(information.redirect_uris)
    && information.redirect_uris.includes(redirectUrl.toString());
}

function assertIssuer(
  stored: string | undefined,
  requested: string | undefined,
  serverName: string,
): void {
  if (stored === undefined || requested === undefined || issuersMatch(stored, requested)) return;
  throw new Error(`OAuth authorization server changed for ${serverName}; log out before authenticating again`);
}

function issuersMatch(first: string, second: string): boolean {
  return first === second;
}

function oauthProfile(config: LocalMcpOAuthConfig, redirectUrl: URL): string {
  return JSON.stringify({
    redirectUri: redirectUrl.toString(),
    ...(config.scope === undefined ? {} : { scope: config.scope }),
    clientName: config.clientName ?? DEFAULT_CLIENT_NAME,
    clientUri: config.clientUri ?? DEFAULT_CLIENT_URI,
    ...(config.authorizationParams === undefined
      ? {}
      : {
        authorizationParams: Object.entries(config.authorizationParams)
          .sort(([left], [right]) => left.localeCompare(right)),
      }),
  });
}

function validateRedirectUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error('OAuth redirectUri must be an absolute URL', { cause: error });
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'http:'
    || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)
    || !url.port
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error('OAuth redirectUri must be an HTTP loopback URL with an explicit port and no credentials, query, or fragment');
  }
  return url;
}

function validateAuthorizationUrl(value: URL): URL {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('OAuth authorization URL must use HTTPS');
  }
  if (url.username || url.password) throw new Error('OAuth authorization URL must not contain credentials');
  return url;
}

function generateState(): string {
  return randomBytes(32).toString('base64url');
}

function combineSignals(...signals: AbortSignal[]): AbortSignal {
  return signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
}

