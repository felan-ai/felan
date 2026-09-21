import { createSessionCompactionExtension } from './compaction.js';
import { registerSessionRecall } from './recall.js';
import { associateExtensionConfig, type FelanExtension } from '@felan-ai/agent-core';
import { SESSION_COMPACTION_CONFIG } from './config.js';

export { createSessionCompactionExtension, SESSION_COMPACTION_BOUNDS } from './compaction.js';
export { registerSessionRecall } from './recall.js';
export {
  DEFAULT_SESSION_COMPACTION_CONFIG,
  SESSION_COMPACTION_CONFIG,
  SESSION_COMPACTION_MODELS,
  SESSION_COMPACTION_METHODS,
  type SessionCompactionConfig,
  type SessionCompactionMethod,
  type SessionCompactionModel,
} from './config.js';
export {
  COMPACTION_CHOICE_CRITERIA,
} from './classifier.js';
export type {
  CompactionClassifierChoice,
  CompactionClassifierChoiceAnswer,
  CompactionClassifierQuestion,
} from './classifier.js';
export type {
  EvidencePruneAction,
  EvidencePruneContext,
  EvidencePruneDebug,
  EvidencePruneDecision,
  EvidencePruneLeftover,
  EvidencePruneLeftoverReason,
  EvidencePruneReport,
  EvidencePruneSkipReason,
  EvidencePruneTrigger,
} from './prune.js';
export * from './internal/contracts.js';
export { createFallbackDiagnostic, fallbackDiagnosticBytes, fallbackDiagnosticText } from './internal/fallback-diagnostic.js';

const sessionCompactionExtension: FelanExtension = (pi) => {
  createSessionCompactionExtension()(pi);
  registerSessionRecall(pi);
};

associateExtensionConfig(sessionCompactionExtension, SESSION_COMPACTION_CONFIG);

export default sessionCompactionExtension;
