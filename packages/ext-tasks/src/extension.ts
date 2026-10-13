import { associateExtensionConfig, type ConfiguredFelanExtension, type FelanExtensionAPI } from '@felan-ai/agent-core';
import { createTasksExtension, TASKS_CONFIG } from './index.js';
export * from './index.js';

const extension: ConfiguredFelanExtension = (pi: FelanExtensionAPI) => createTasksExtension()(pi);
associateExtensionConfig(extension, TASKS_CONFIG);

export default extension;

export * from './presentation.js';
export { TASKS_HINT } from './portable-ui.js';
