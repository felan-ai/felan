import type { ExtensionContext } from '@felan-ai/agent-core';

export interface BrowserAuthorizationPresentation {
  consent(origin: string, reason: string | undefined, signal: AbortSignal): Promise<'once' | 'always' | undefined>;
  openSetup(applicationPath: string, signal: AbortSignal): Promise<boolean>;
  ready(signal: AbortSignal): Promise<boolean>;
}
export type BrowserAuthorizationPresentationFactory = (context: ExtensionContext) => BrowserAuthorizationPresentation | undefined;

export const CHROME_ACCESS_MESSAGE = 'Chrome grants browser-wide debugging authority, including authenticated browser data and advanced browser commands. Approve the single Chrome prompt when it appears.';
export const CHROME_READY_MESSAGE = 'Enable remote debugging if it is off. Leave an already-enabled setting unchanged. Continue when ready for one connection attempt.';
