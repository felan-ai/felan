import type { AgentRuntime } from '@felan-ai/agent-core';
import { BROWSER_SETUP_PRESENTER, BrowserSetupRequestSchema } from '@felan-ai/ext-browser/presentation';
import { parseSchema } from '@felan-ai/session-protocol';
import { openChromeSetup } from '../browser-presentation.js';
import type { ClientInteractionPresenters } from './presenters.js';

export function registerBrowserSetupPresenter(
  presenters: Pick<ClientInteractionPresenters, 'registerCustom'>,
  runtime: AgentRuntime,
): () => void {
  return presenters.registerCustom(BROWSER_SETUP_PRESENTER, async (data, signal) => {
    const request = parseSchema(BrowserSetupRequestSchema, data);
    await openChromeSetup(runtime, request.applicationPath, signal);
    return { opened: true };
  });
}
