import type {
  FetchLike,
  OAuthClientProvider,
} from '@modelcontextprotocol/client';
import type { ExtensionContext } from '@felan-ai/agent-core';

export type McpHttpTransport = 'auto' | 'streamable-http' | 'sse';

export interface McpServerConfig {
  readonly url: string;
  readonly auth: 'oauth';
  readonly transport?: McpHttpTransport;
  readonly requestTimeoutMs?: number;
}

export interface McpSettings {
  readonly requestTimeoutMs?: number;
}

export interface McpConfig {
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
  readonly settings?: McpSettings;
}

export interface ResolvedMcpServer {
  readonly name: string;
  readonly url: string;
  readonly auth: 'oauth';
  readonly transport: McpHttpTransport;
  readonly requestTimeoutMs?: number;
}

export interface McpOAuthSessionContext {
  readonly sessionId: string;
  readonly signal: AbortSignal;
}

export interface McpOAuthAuthenticationContext {
  readonly reason: 'explicit';
  readonly signal: AbortSignal;
  readonly extensionContext: ExtensionContext;
}

export type McpOAuthAuthenticationOutcome =
  | { readonly status: 'authenticated' }
  | {
    readonly status: 'cancelled' | 'unavailable';
    readonly message: string;
  };

export interface McpOAuthSession {
  providerFor(
    server: ResolvedMcpServer,
    signal: AbortSignal,
  ): Promise<OAuthClientProvider>;
  authenticate(
    server: ResolvedMcpServer,
    context: McpOAuthAuthenticationContext,
  ): Promise<McpOAuthAuthenticationOutcome>;
  logout(server: ResolvedMcpServer, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export interface McpOAuthHost {
  createSession(context: McpOAuthSessionContext): Promise<McpOAuthSession>;
}

export interface CreateMcpExtensionOptions {
  readonly config: McpConfig;
  readonly oauthHost: McpOAuthHost;
  /** Consumer-owned HTTP policy used by MCP transports and transport-driven OAuth refresh/discovery. */
  readonly fetch?: FetchLike;
}
