import { configField, defineExtensionConfig } from '@felan-ai/agent-core';
import { validateConfiguredAutoIndexPath } from './auto-index-paths.js';

export const CODEBASE_MEMORY_CONFIG = defineExtensionConfig({
  id: 'codebaseMemory',
  title: 'Codebase Memory',
  fields: {
    mode: configField.enum(['curated', 'direct', 'proxy'], {
      default: 'curated',
      description: 'Model-facing Codebase Memory tool surface',
    }),
    autoIndexPath: configField.string({
      default: '',
      description: 'Absolute directory to index at session startup; empty uses the Git root or runtime cwd',
      validate: validateConfiguredAutoIndexPath,
    }),
    maxCacheBytes: configField.number({
      default: 0,
      description: 'Maximum bytes retained by the Codebase Memory LRU cache; 0 uses the runtime default',
      validate: (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? undefined
        : 'must be a non-negative integer',
    }),
  },
});
