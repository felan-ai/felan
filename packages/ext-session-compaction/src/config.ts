import {
  MODEL_TIERS,
  configField,
  defineExtensionConfig,
} from '@felan-ai/agent-core';

export const SESSION_COMPACTION_MODELS = ['inherit', ...MODEL_TIERS] as const;

export type SessionCompactionModel = (typeof SESSION_COMPACTION_MODELS)[number];

export interface SessionCompactionConfig {
  readonly model: SessionCompactionModel;
}

export const DEFAULT_SESSION_COMPACTION_CONFIG: SessionCompactionConfig = {
  model: 'inherit',
};

export const SESSION_COMPACTION_CONFIG = defineExtensionConfig({
  id: 'sessionCompaction',
  title: 'Session Compaction',
  fields: {
    model: configField.enum(SESSION_COMPACTION_MODELS, {
      default: DEFAULT_SESSION_COMPACTION_CONFIG.model,
      label: 'Summary model',
      description: 'Model tier for verified summaries; inherit uses the active session model',
    }),
  },
});
