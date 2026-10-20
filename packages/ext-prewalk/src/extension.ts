import { SESSIONS_SERVICE, associateExtensionConfig, type ConfiguredFelanExtension, type FelanExtensionAPI } from '@felan-ai/agent-core';
import { createPrewalkExtension, PREWALK_CONFIG } from './index.js';
import { createPrewalkUiHost } from './ui.js';
export * from './index.js';

const extension: ConfiguredFelanExtension = Object.assign((pi: FelanExtensionAPI) => {
  const { host, dispose } = createPrewalkUiHost(pi.ui);
  pi.on('session_shutdown', dispose);
  return createPrewalkExtension(host)(pi);
}, { serviceRequirements: { optional: [SESSIONS_SERVICE] } });

associateExtensionConfig(extension, PREWALK_CONFIG);
export default extension;

export * from './plan-review-contracts.js';
export { PREWALK_FORM_HINT } from './ui.js';
