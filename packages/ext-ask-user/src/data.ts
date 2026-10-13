
export const ASK_USER_FORM_HINT = { id: 'ask-user.wizard', version: '1' } as const;
export * from './contracts.js';
export { DEFAULT_ASK_USER_CONFIG, normalizeAskUserShortcut, type AskUserConfig } from './config.js';
export { normalizeAskUserOption } from './normalize.js';
