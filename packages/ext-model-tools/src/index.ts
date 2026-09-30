import type { FelanExtension } from '@felan-ai/agent-core';
import { registerClassify } from './classify.js';
import { registerImages } from './images.js';
import type { ModelToolsRuntime } from './models.js';

export { discoverImageModels } from './models.js';
export type { ModelToolsRuntime } from './models.js';

export function createModelToolsExtension(models?: ModelToolsRuntime): FelanExtension {
  return async (pi) => {
    registerClassify(pi);
    await registerImages(pi, models);
  };
}

export default createModelToolsExtension();
