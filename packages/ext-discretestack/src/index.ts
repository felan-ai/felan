import type { ExtensionFactory } from '@felan-ai/agent-core';
import { DISCRETESTACK_PROVIDER, DISCRETESTACK_PROVIDER_ID } from './provider.js';

export function createDiscreteStackExtension(): ExtensionFactory {
  return (pi) => {
    pi.registerProvider(DISCRETESTACK_PROVIDER_ID, DISCRETESTACK_PROVIDER);
  };
}

export default createDiscreteStackExtension();
