import { SESSIONS_HISTORY_SERVICE, associateExtensionConfig, type ConfiguredFelanExtension, type ExtensionContext, type FelanExtensionAPI } from '@felan-ai/agent-core';
import { PROMPT_HISTORY_CONFIG } from './index.js';
import { createCommonPromptHistory } from './common-ui.js';
import { createPromptHistorySource, searchPromptHistory } from './history.js';
import { createSessionsPromptHistory } from './sessions.js';
export * from './index.js';

const extension = Object.assign((pi: FelanExtensionAPI) => {
  const sessions = pi.services.get(SESSIONS_HISTORY_SERVICE);
  if (!sessions) throw new Error(`Required service ${SESSIONS_HISTORY_SERVICE.key} has no configured provider.`);
  const lifetime = new AbortController();
  const presentation = createCommonPromptHistory(pi.ui);
  const open = async (ctx: ExtensionContext) => {
    lifetime.signal.throwIfAborted();
    const source = createPromptHistorySource(ctx, createSessionsPromptHistory(sessions, lifetime.signal));
    await presentation.show((...args) => searchPromptHistory(source, ...args), lifetime.signal);
  };
  pi.registerCommand('prompt-history', { description: 'Search prompt history', handler: async (_args, ctx) => open(ctx) });
  pi.registerShortcut('ctrl+r', { description: 'Search prompt history', handler: open });
  pi.registerShortcut('super+r', { description: 'Search prompt history', handler: open });
  pi.on('session_shutdown', async () => { lifetime.abort(); await presentation.dispose(); });
}, {
  serviceRequirements: { required: [SESSIONS_HISTORY_SERVICE] },
}) as ConfiguredFelanExtension;

associateExtensionConfig(extension, PROMPT_HISTORY_CONFIG);
export default extension;

export { PROMPT_HISTORY_HINT } from './common-ui.js';
export { PROMPT_HISTORY_SCOPES } from './contracts.js';
export type { PromptHistoryItem, PromptHistoryScope } from './contracts.js';
