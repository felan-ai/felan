import { Type } from 'typebox';
import type { ExtensionContext } from '@felan-ai/agent-core';

export interface BrowserAuthorizationPresentation {
  consent(origin: string, reason: string | undefined, signal: AbortSignal): Promise<'once' | 'always' | undefined>;
  openSetup(applicationPath: string, signal: AbortSignal): Promise<boolean>;
  ready(signal: AbortSignal): Promise<boolean>;
}
export type BrowserAuthorizationPresentationFactory = (context: ExtensionContext) => BrowserAuthorizationPresentation | undefined;

export const BROWSER_SETUP_PRESENTER = Object.freeze({ id: 'felan.browser.setup', version: '1' });
export const CHROME_ACCESS_MESSAGE = 'Chrome grants browser-wide debugging authority, including authenticated browser data and advanced browser commands. Approve the single Chrome prompt when it appears.';
export const CHROME_READY_MESSAGE = 'Enable remote debugging if it is off. Leave an already-enabled setting unchanged. Continue when ready for one connection attempt.';
export const BrowserSetupRequestSchema = Type.Object({ applicationPath: Type.String({ minLength: 1, maxLength: 4096 }) }, { additionalProperties: false });
export const BrowserSetupResultSchema = Type.Object({ opened: Type.Literal(true) }, { additionalProperties: false });
