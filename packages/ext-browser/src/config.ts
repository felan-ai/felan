import { configField, defineExtensionConfig } from '@felan-ai/agent-core';

export const BROWSER_AUTHORIZATION_POLICIES = ['ask', 'always-allow'] as const;
export type BrowserAuthorizationPolicy = (typeof BROWSER_AUTHORIZATION_POLICIES)[number];

export const BROWSER_CONFIG = defineExtensionConfig({
  id: 'browser',
  title: 'Browser',
  fields: {
    authorizationPolicy: configField.enum(BROWSER_AUTHORIZATION_POLICIES, {
      default: 'ask',
      label: 'Existing-browser authorization',
      description: 'Whether Felan asks before reusing an existing Chrome session',
    }),
  },
});
