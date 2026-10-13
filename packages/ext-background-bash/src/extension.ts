import { associateExtensionConfig, type ConfiguredFelanExtension, type FelanExtensionAPI } from '@felan-ai/agent-core';
import { BACKGROUND_BASH_CONFIG, createBackgroundBashExtension } from './index.js';
export * from './index.js';

const extension = ((pi: FelanExtensionAPI) => createBackgroundBashExtension()(pi)) as ConfiguredFelanExtension;

associateExtensionConfig(extension, BACKGROUND_BASH_CONFIG);
export default extension;

export { PROCESSES_HINT } from './common-ui.js';
