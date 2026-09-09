import {
  associateExtensionConfig,
  type Api,
  type FelanExtension,
  type Model,
} from '@felan-ai/agent-core';
import { CODEX_CONFIG, DEFAULT_CODEX_CONFIG } from './config.js';
import { registerPostAgentRunCompaction } from './compaction.js';
import { supportsCodexModel } from './model-policy.js';
import { applyCodexRequestOptions } from './request-options.js';
import { CODEX_TOOL_NAMES, createCodexTools, registerPatchResultEvent } from './tools.js';

const REPLACED_TOOL_NAMES: ReadonlySet<string> = new Set(['edit', 'write']);
const CODEX_TOOL_NAME_SET: ReadonlySet<string> = new Set(CODEX_TOOL_NAMES);
const codexExtension: FelanExtension = async (pi) => {
  const config = { ...DEFAULT_CODEX_CONFIG, ...pi.config } as import('./config.js').CodexConfig;
  registerPostAgentRunCompaction(pi, config);
  for (const tool of createCodexTools(pi.runtime)) pi.registerTool(tool);
  registerPatchResultEvent(pi);

  let ordinaryTools: string[] | undefined;
  const synchronizeTools = (model: Model<Api> | undefined) => {
    const current = pi.getActiveTools();
    ordinaryTools ??= current.filter((name) => !CODEX_TOOL_NAME_SET.has(name));
    const active = supportsCodexModel(model);
    if (active) {
      pi.setActiveTools([
        ...current.filter((name) => !REPLACED_TOOL_NAMES.has(name) && !CODEX_TOOL_NAME_SET.has(name)),
        ...CODEX_TOOL_NAMES,
      ]);
    } else {
      const restored = current.filter((name) => !CODEX_TOOL_NAME_SET.has(name));
      for (const name of ordinaryTools) {
        if (REPLACED_TOOL_NAMES.has(name) && !restored.includes(name)) restored.push(name);
      }
      pi.setActiveTools(restored);
    }
  };

  pi.on('session_start', (_event, ctx) => synchronizeTools(ctx.model));
  pi.on('model_select', (event) => synchronizeTools(event.model));
  pi.on('before_provider_request', (event, ctx) => (
    applyCodexRequestOptions(event.payload, ctx, config)
  ));
};

export { CODEX_CONFIG, DEFAULT_CODEX_CONFIG, validateCodexConfig } from './config.js';
export type { CodexConfig, CodexVerbosity } from './config.js';
export { supportsCodexModel, supportsCodexResponsesRequest } from './model-policy.js';
export { registerPostAgentRunCompaction } from './compaction.js';
export { applyCodexRequestOptions } from './request-options.js';
export { CODEX_TOOL_NAMES, createCodexTools } from './tools.js';
export {
  createCodexStreamFunctionWrapper,
  resolveCodexStreamOptions,
  resolveCodexTransport,
} from './transport.js';
export default codexExtension;
associateExtensionConfig(codexExtension, CODEX_CONFIG);
