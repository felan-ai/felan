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
}

export const DEFAULT_SESSION_COMPACTION_CONFIG: SessionCompactionConfig = {
  method: 'classifier',
  model: 'inherit',
};

export const SESSION_COMPACTION_CONFIG = defineExtensionConfig({
  id: 'sessionCompaction',
  title: 'Session Compaction',
  fields: {
    method: configField.enum(SESSION_COMPACTION_METHODS, {
      default: DEFAULT_SESSION_COMPACTION_CONFIG.method,
      label: 'Method',
      description: 'Classifier selectively retains the prepared transcript when available; summary disables classification',
    }),
    model: configField.enum(SESSION_COMPACTION_MODELS, {
      default: DEFAULT_SESSION_COMPACTION_CONFIG.model,
      label: 'Summary model',
      description: 'Model tier for verified summaries; inherit uses the active session model',
    }),
  },
});
