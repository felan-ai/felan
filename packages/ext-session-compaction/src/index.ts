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
  type SessionCompactionConfig,
  type SessionCompactionModel,
} from './config.js';
export * from './internal/contracts.js';
export { createFallbackDiagnostic, fallbackDiagnosticBytes, fallbackDiagnosticText } from './internal/fallback-diagnostic.js';

const sessionCompactionExtension: FelanExtension = (pi) => {
  createSessionCompactionExtension()(pi);
  registerSessionRecall(pi);
};

associateExtensionConfig(sessionCompactionExtension, SESSION_COMPACTION_CONFIG);

export default sessionCompactionExtension;
