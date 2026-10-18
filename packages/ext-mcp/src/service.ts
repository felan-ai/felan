import { defineServiceContract } from '@felan-ai/agent-core';

export interface OAuthCallbackResult {
  readonly code: string;
  readonly iss?: string;
}

export interface OAuthCallbackReservation {
  readonly redirectUri: string;
  wait(): Promise<OAuthCallbackResult>;
  release(): void;
}

export interface McpOAuthCallbackService {
  reserve(redirectUri: string, state: string, signal: AbortSignal, timeoutMs?: number): Promise<OAuthCallbackReservation>;
  openAuthorizationUrl?(url: string, signal: AbortSignal): Promise<void>;
}

export const MCP_OAUTH_CALLBACK_SERVICE = defineServiceContract<McpOAuthCallbackService>('felan.mcp.oauth-callback', 1);
