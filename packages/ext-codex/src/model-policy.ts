import type { Api, Model } from '@felan-ai/agent-core';

const CODEX_PROVIDERS: ReadonlySet<string> = new Set(['openai', 'openai-codex']);

export function supportsCodexModel(model: Model<Api> | undefined): boolean {
  if (!model || !CODEX_PROVIDERS.has(model.provider)) return false;
  return /^gpt(?:-|$)/iu.test(model.id);
}

export function supportsCodexResponsesRequest(model: Model<Api> | undefined): boolean {
  return supportsCodexModel(model)
    && (model!.api === 'openai-responses' || model!.api === 'openai-codex-responses');
}

export function supportsImageInput(model: Model<Api> | undefined): boolean {
  return supportsCodexModel(model) && Array.isArray(model!.input) && model!.input.includes('image');
}
