import {
  MODEL_TIERS,
  configField,
  defineExtensionConfig,
} from '@felan-ai/agent-core';

export const SESSION_COMPACTION_MODELS = ['inherit', ...MODEL_TIERS] as const;
export const SESSION_COMPACTION_METHODS = ['summary', 'classifier'] as const;

export type SessionCompactionModel = (typeof SESSION_COMPACTION_MODELS)[number];
export type SessionCompactionMethod = (typeof SESSION_COMPACTION_METHODS)[number];

export interface SessionCompactionConfig {
  readonly method: SessionCompactionMethod;
  readonly model: SessionCompactionModel;
  readonly compactBeforeCacheExpiry: boolean;
  readonly minContextTokens: number;
}

export const DEFAULT_SESSION_COMPACTION_CONFIG: SessionCompactionConfig = {
  method: 'summary',
  model: 'inherit',
  compactBeforeCacheExpiry: true,
  minContextTokens: 200_000,
};

export const SESSION_COMPACTION_CONFIG = defineExtensionConfig({
  id: 'sessionCompaction',
  title: 'Session Compaction',
  fields: {
    method: configField.enum(SESSION_COMPACTION_METHODS, {
      default: DEFAULT_SESSION_COMPACTION_CONFIG.method,
      label: 'Method',
      description: 'Summary generates a verified checkpoint; classifier selectively retains the prepared transcript when available',
    }),
    model: configField.enum(SESSION_COMPACTION_MODELS, {
      default: DEFAULT_SESSION_COMPACTION_CONFIG.model,
      label: 'Summary model',
      description: 'Model tier for verified summaries; inherit uses the active session model',
    }),
    compactBeforeCacheExpiry: configField.boolean({
      default: DEFAULT_SESSION_COMPACTION_CONFIG.compactBeforeCacheExpiry,
      label: 'Compact before cache expiry',
      description: 'When idle, compact shortly before a known prompt-cache lifetime expires',
    }),
    minContextTokens: configField.number({
      default: DEFAULT_SESSION_COMPACTION_CONFIG.minContextTokens,
      label: 'Expiry compaction minimum',
      description: 'Smallest context (tokens) worth compacting before cache expiry',
      validate: (value) => typeof value === 'number' && Number.isInteger(value) && value >= 0
        ? undefined : 'Must be a finite integer greater than or equal to 0',
    }),
  },
});
