import { configField, defineExtensionConfig } from '@felan-ai/agent-core';

export const CODEBASE_MEMORY_CONFIG = defineExtensionConfig({
  id: 'codebaseMemory',
  title: 'Codebase Memory',
  fields: {
    maxCacheBytes: configField.number({
      default: 0,
      description: 'Maximum bytes retained by the Codebase Memory LRU cache; 0 uses the runtime default',
      validate: (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? undefined
        : 'must be a non-negative integer',
    }),
  },
});
