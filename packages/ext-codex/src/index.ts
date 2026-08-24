import {
  associateExtensionConfig,
  type Api,
  type FelanExtension,
  type Model,
} from '@felan-ai/agent-core';
import { CODEX_CONFIG, DEFAULT_CODEX_CONFIG } from './config.js';
import { ExecSessionManager } from './exec-session-manager.js';
import { supportsCodexModel, supportsImageInput } from './model-policy.js';
import { injectCodexSkills } from './prompt.js';
import { applyCodexRequestOptions } from './request-options.js';
import { CODEX_TOOL_NAMES, createCodexTools, registerPatchResultEvent } from './tools.js';

const REPLACED_TOOL_NAMES: ReadonlySet<string> = new Set(['read', 'bash', 'edit', 'write']);
const CODEX_TOOL_NAME_SET: ReadonlySet<string> = new Set(CODEX_TOOL_NAMES);

const codexExtension: FelanExtension = async (pi) => {
  const config = { ...DEFAULT_CODEX_CONFIG, ...pi.config } as import('./config.js').CodexConfig;
  const sessions = new ExecSessionManager(pi.runtime);
  for (const tool of createCodexTools(pi.runtime, sessions)) pi.registerTool(tool);
  registerPatchResultEvent(pi);

  let ordinaryTools: string[] | undefined;
  const synchronizeTools = (model: Model<Api> | undefined) => {
    const current = pi.getActiveTools();
    ordinaryTools ??= current.filter((name) => !CODEX_TOOL_NAME_SET.has(name));
    if (supportsCodexModel(model) && pi.runtime.processes) {
      pi.setActiveTools([
        ...current.filter((name) => !REPLACED_TOOL_NAMES.has(name) && !CODEX_TOOL_NAME_SET.has(name)),
        ...CODEX_TOOL_NAMES.filter((name) => name !== 'view_image' || supportsImageInput(model)),
      ]);
      return;
    }
    const restored = current.filter((name) => !CODEX_TOOL_NAME_SET.has(name));
    for (const name of ordinaryTools) {
      if (REPLACED_TOOL_NAMES.has(name) && !restored.includes(name)) restored.push(name);
    }
    pi.setActiveTools(restored);
  };

  pi.on('session_start', (_event, ctx) => synchronizeTools(ctx.model));
  pi.on('model_select', (event) => synchronizeTools(event.model));
  pi.on('before_agent_start', (event, ctx) => {
    if (!supportsCodexModel(ctx.model) || !pi.runtime.processes) return undefined;
    const systemPrompt = injectCodexSkills(event.systemPrompt, event.systemPromptOptions.skills);
    return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
  });
  pi.on('before_provider_request', (event, ctx) => (
    applyCodexRequestOptions(event.payload, ctx, config)
  ));
  pi.on('session_shutdown', async () => {
    await sessions.shutdown();
  });
};

export { CODEX_CONFIG, DEFAULT_CODEX_CONFIG, validateCodexConfig } from './config.js';
export type { CodexConfig, CodexVerbosity } from './config.js';
export { ExecSessionManager, formatExecResult } from './exec-session-manager.js';
export type { ExecCommandInput, UnifiedExecResult, WriteStdinInput } from './exec-session-manager.js';
export { supportsCodexModel, supportsCodexResponsesRequest } from './model-policy.js';
export { applyCodexRequestOptions } from './request-options.js';
export { CODEX_TOOL_NAMES, MAX_VIEW_IMAGE_INPUT_BYTES, createCodexTools } from './tools.js';
export {
  createCodexStreamFunctionWrapper,
  resolveCodexStreamOptions,
  resolveCodexTransport,
} from './transport.js';
export default codexExtension;
associateExtensionConfig(codexExtension, CODEX_CONFIG);
