import { MODELS_SERVICE, type ConfiguredFelanExtension, type FelanExtensionAPI } from '@felan-ai/agent-core';
import { createModelToolsExtension } from './index.js';
export * from './index.js';

const extension = Object.assign((pi: FelanExtensionAPI) => createModelToolsExtension(pi.services.get(MODELS_SERVICE))(pi), {
  serviceRequirements: { optional: [MODELS_SERVICE] },
}) as ConfiguredFelanExtension;

export default extension;
