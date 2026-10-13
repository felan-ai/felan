import { associateExtensionConfig, type ConfiguredFelanExtension, type FelanExtensionAPI } from '@felan-ai/agent-core';
import { ASK_USER_CONFIG, createAskUserExtension } from './index.js';
import { createUiAskUserHost } from './ui.js';
export * from './index.js';

const extension = Object.assign((pi: FelanExtensionAPI) => {
  return createAskUserExtension(createUiAskUserHost(pi.ui))(pi);
}, { serviceRequirements: {} }) as ConfiguredFelanExtension;
associateExtensionConfig(extension, ASK_USER_CONFIG);

export default extension;

export { normalizeAskUserOption } from './normalize.js';
export { ASK_USER_FORM_HINT } from './ui.js';
