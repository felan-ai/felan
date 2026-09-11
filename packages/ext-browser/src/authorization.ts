import type { ExtensionContext } from '@felan-ai/agent-core';

export interface BrowserAuthorizationConnection {
  readonly port: number;
  readonly webSocketPath: string;
}

export interface BrowserAuthorizationAttachment {
  readonly ready: boolean;
  readonly reason?: string;
}

export interface BrowserAuthorizationLease {
  readonly signal: AbortSignal;
  close(): Promise<void>;
}

export interface BrowserAuthorizationRequest {
  readonly origin: string;
  readonly signal: AbortSignal;
  readonly extensionContext: ExtensionContext;
  readonly attach: (
    connection: BrowserAuthorizationConnection,
    lease?: BrowserAuthorizationLease,
  ) => Promise<BrowserAuthorizationAttachment>;
}

export type BrowserAuthorizationOutcome =
  | { readonly status: 'authorized' | 'cancelled' | 'unavailable'; readonly message?: string };

export interface BrowserAuthorizationHost {
  /** Inherited CLI configuration can select an attached browser even for an isolated command. */
  checkExecution?(): void | Promise<void>;
  authorize(request: BrowserAuthorizationRequest): Promise<BrowserAuthorizationOutcome>;
}
