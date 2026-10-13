import { associateExtensionConfig, type ConfiguredFelanExtension, type FelanExtensionAPI } from '@felan-ai/agent-core';
import { createBrowserExtension } from './index.js';
import { BROWSER_CONFIG } from './config.js';
import { BROWSER_AUTHORIZATION_SERVICE } from './service.js';
export * from './index.js';

const extension = Object.assign((pi: FelanExtensionAPI) => {
  const service = pi.services.get(BROWSER_AUTHORIZATION_SERVICE);
  if (!service) return createBrowserExtension()(pi);
  const authorizationPolicy = pi.config.authorizationPolicy ?? BROWSER_CONFIG.fields.authorizationPolicy.default;
  if (authorizationPolicy !== 'ask' && authorizationPolicy !== 'always-allow') {
    throw new Error('Invalid browser authorization policy.');
  }
  return createBrowserExtension({
    authorizationHost: {
      checkExecution: () => service.checkExecution?.(),
      authorize: request => service.authorize({ ...request, authorizationPolicy }),
    },
  })(pi);
}, { serviceRequirements: { optional: [BROWSER_AUTHORIZATION_SERVICE] } }) satisfies ConfiguredFelanExtension;

associateExtensionConfig(extension, BROWSER_CONFIG);
export default extension;
