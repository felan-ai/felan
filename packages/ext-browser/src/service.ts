import { defineServiceContract } from '@felan-ai/agent-core';
import type { BrowserAuthorizationHost, BrowserAuthorizationOutcome, BrowserAuthorizationRequest } from './authorization.js';
import type { BrowserAuthorizationPolicy } from './config.js';
import type { BrowserLiveViewService } from './live-view.js';

export type { BrowserLiveViewService, BrowserLiveViewSession, BrowserLiveViewStream } from './live-view.js';

export interface BrowserAuthorizationServiceRequest extends BrowserAuthorizationRequest {
  readonly authorizationPolicy: BrowserAuthorizationPolicy;
}

export interface BrowserAuthorizationService {
  readonly checkExecution?: BrowserAuthorizationHost['checkExecution'];
  authorize(request: BrowserAuthorizationServiceRequest): Promise<BrowserAuthorizationOutcome>;
}

export const BROWSER_AUTHORIZATION_SERVICE = defineServiceContract<BrowserAuthorizationService>('felan.browser.authorization', 1);
export const BROWSER_LIVE_VIEW_SERVICE = defineServiceContract<BrowserLiveViewService>('felan.browser.live-view', 1);
