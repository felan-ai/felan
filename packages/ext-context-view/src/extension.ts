import { type ConfiguredFelanExtension, type FelanExtensionAPI } from '@felan-ai/agent-core';
import { createContextViewExtension } from './index.js';
import { createContextViewUiHost } from './ui.js';
export * from './index.js';

const extension: ConfiguredFelanExtension = (pi: FelanExtensionAPI) => createContextViewExtension(createContextViewUiHost(pi.ui))(pi);

export default extension;

export * from './report.js';
