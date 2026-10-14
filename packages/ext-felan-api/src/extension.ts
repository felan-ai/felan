import { FELAN_PLATFORM_SERVICE, type ConfiguredFelanExtension, type FelanExtensionAPI } from '@felan-ai/agent-core';
import { createFelanPlatformExtension } from './index.js';
export * from './index.js';

const extension = Object.assign((pi: FelanExtensionAPI) => {
  const platform = pi.services.get(FELAN_PLATFORM_SERVICE);
  if (platform) return createFelanPlatformExtension(platform)(pi);
}, {
  serviceRequirements: { optional: [FELAN_PLATFORM_SERVICE] },
}) as ConfiguredFelanExtension;

export default extension;
