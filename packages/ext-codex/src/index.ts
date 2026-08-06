import {
  builtinProviders,
  type Api,
  type FelanExtension,
  type Model,
} from '@felan-ai/agent-core';
import { readCodexConfig } from './config.js';
import { ExecSessionManager } from './exec-session-manager.js';
import { supportsCodexModel } from './model-policy.js';
import { applyCodexRequestOptions } from './request-options.js';
import { CODEX_TOOL_NAMES, createCodexTools, registerPatchResultEvent } from './tools.js';
import { wrapOpenAICodexProvider } from './transport.js';

const REPLACED_TOOL_NAMES: ReadonlySet<string> = new Set(['read', 'bash', 'edit', 'write']);
const CODEX_TOOL_NAME_SET: ReadonlySet<string> = new Set(CODEX_TOOL_NAMES);

const codexExtension: FelanExtension = async (pi) => {
  const config = await readCodexConfig(pi.runtime, pi.agentDir);
  const sessions = new ExecSessionManager(pi.runtime);
  for (const tool of createCodexTools(pi.runtime, sessions)) pi.registerTool(tool);
  registerPatchResultEvent(pi);

  const nativeProvider = builtinProviders().find((provider) => provider.id === 'openai-codex');
  if (!nativeProvider) throw new Error('Pi OpenAI Codex provider is unavailable');
  pi.registerProvider(wrapOpenAICodexProvider(nativeProvider, config));

  let ordinaryTools: string[] | undefined;
  const synchronizeTools = (model: Model<Api> | undefined) => {
    const current = pi.getActiveTools();
    ordinaryTools ??= current.filter((name) => !CODEX_TOOL_NAME_SET.has(name));
    if (supportsCodexModel(model)) {
      pi.setActiveTools([
        ...current.filter((name) => !REPLACED_TOOL_NAMES.has(name) && !CODEX_TOOL_NAME_SET.has(name)),
        ...CODEX_TOOL_NAMES,
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
  pi.on('before_provider_request', (event, ctx) => (
    applyCodexRequestOptions(event.payload, ctx, config)
  ));
  pi.on('session_shutdown', async () => {
    await sessions.shutdown();
    pi.unregisterProvider('openai-codex');
  });
};

export { DEFAULT_CODEX_CONFIG, readCodexConfig, validateCodexConfig } from './config.js';
export type { CodexConfig, CodexVerbosity } from './config.js';
export { ExecSessionManager, formatExecResult } from './exec-session-manager.js';
export type { ExecCommandInput, UnifiedExecResult, WriteStdinInput } from './exec-session-manager.js';
export { supportsCodexModel, supportsCodexResponsesRequest } from './model-policy.js';
export { applyCodexRequestOptions } from './request-options.js';
export { CODEX_TOOL_NAMES, createCodexTools } from './tools.js';
export { resolveCodexTransport, wrapOpenAICodexProvider } from './transport.js';
export default codexExtension;
