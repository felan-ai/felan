import { configField, defineExtensionConfig, type InferExtensionConfig } from '@felan-ai/agent-core';
import { indexTimeoutMs } from './cbm/timeouts.js';

const positive = (value: unknown): string | undefined => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? undefined : 'must be a positive finite number'
);

export const CODEBASE_MEMORY_CONFIG = defineExtensionConfig({
  id: 'codebaseMemory',
  title: 'Codebase Memory',
  fields: {
    disabled: configField.boolean({ default: false, description: 'Disable all Codebase Memory tools and hooks.' }),
    maxCacheBytes: configField.number({ default: 0, description: 'Cache cap in bytes; 0 selects the runtime-aware default.', validate: (value) => value === 0 ? undefined : positive(value) }),
    queryTimeoutMs: configField.number({ default: 60_000, description: 'Maximum query duration in milliseconds.', validate: positive }),
    indexTimeoutMs: configField.number({ default: 1_200_000, description: 'Maximum startup and refresh indexing duration in milliseconds.', validate: positive }),
    augmentation: configField.boolean({ default: true, description: 'Add bounded graph context to grep/find/shell search results.' }),
    augmentTimeoutMs: configField.number({ default: 1_500, description: 'Maximum result augmentation duration in milliseconds.', validate: positive }),
    maxSymbolLines: configField.number({ default: 220, description: 'Maximum source lines returned per symbol.', validate: positive }),
  },
});

export type CodebaseMemoryConfig = InferExtensionConfig<typeof CODEBASE_MEMORY_CONFIG>;

export function codebaseMemoryConfig(value: Readonly<Record<string, unknown>>): CodebaseMemoryConfig {
  return {
    disabled: value.disabled === true,
    maxCacheBytes: numberValue(value.maxCacheBytes, 0),
    queryTimeoutMs: numberValue(value.queryTimeoutMs, 60_000),
    indexTimeoutMs: indexTimeoutMs(value.indexTimeoutMs),
    augmentation: value.augmentation !== false,
    augmentTimeoutMs: numberValue(value.augmentTimeoutMs, 1_500),
    maxSymbolLines: numberValue(value.maxSymbolLines, 220),
  };
}

function numberValue(value: unknown, fallback: number): number { return typeof value === 'number' ? value : fallback; }
