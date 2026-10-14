import { associateExtensionConfig, MODELS_SERVICE, SESSIONS_SERVICE, USAGE_SERVICE, type ConfiguredFelanExtension, type FelanExtensionAPI } from '@felan-ai/agent-core';
import { createPowerlineRuntimeExtension, POWERLINE_CONFIG } from './runtime.js';
import { createSavingsUsage, createSessionUsage } from './core-services.js';
export * from './runtime.js';

const extension = Object.assign((pi: FelanExtensionAPI) => {
  const models = pi.services.get(MODELS_SERVICE);
  const usage = pi.services.get(USAGE_SERVICE);
  const sessions = pi.services.get(SESSIONS_SERVICE);
  const version = pi.runtime.host?.version;
  const subscription = models?.getSubscriptionUsage ? { fetchUsage: (request: import('./subscription.js').SubscriptionUsageHostRequest) => models.getSubscriptionUsage!({ provider: request.modelProvider, id: request.modelId ?? '' }, { signal: request.signal }) } : undefined;
  return createPowerlineRuntimeExtension(subscription, {
    ...(version === undefined ? {} : { felanVersion: version }),
    ...(usage ? { savingsHost: createSavingsUsage(usage) } : {}),
    ...(sessions ? { additionalSessionUsageHost: createSessionUsage(sessions) } : {}),
  })(pi);
}, {
  serviceRequirements: { optional: [MODELS_SERVICE, SESSIONS_SERVICE, USAGE_SERVICE] },
}) as ConfiguredFelanExtension;

associateExtensionConfig(extension, POWERLINE_CONFIG);
export default extension;

export * from './index.js';
export * from './data.js';
