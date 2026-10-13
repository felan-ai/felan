import { defineServiceContract } from '@felan-ai/agent-core';
import type { BrowserAuthorizationHost, BrowserAuthorizationOutcome, BrowserAuthorizationRequest } from './authorization.js';
import type { BrowserAuthorizationPolicy } from './config.js';

export interface BrowserAuthorizationServiceRequest extends BrowserAuthorizationRequest {
  readonly authorizationPolicy: BrowserAuthorizationPolicy;
}

export interface BrowserAuthorizationService {
  readonly checkExecution?: BrowserAuthorizationHost['checkExecution'];
  authorize(request: BrowserAuthorizationServiceRequest): Promise<BrowserAuthorizationOutcome>;
}

export const BROWSER_AUTHORIZATION_SERVICE = defineServiceContract<BrowserAuthorizationService>('felan.browser.authorization', 1);
