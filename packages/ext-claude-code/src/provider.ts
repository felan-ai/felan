import type { ExtensionAPI } from '@felan-ai/agent-core';
import type { ClaudeCodeSettings } from './bridge/config.js';
import { PROVIDER_ID } from './bridge/convert.js';
import { CLAUDE_CODE_MODELS, applyLongContext, longContextSettings } from './bridge/models.js';

type ProviderConfig = Parameters<ExtensionAPI['registerProvider']>[1];

export const CLAUDE_CODE_PROVIDER_ID = PROVIDER_ID;

/**
 * Lists Claude Code's models in a daemon's host model registry, which validates a model a client
 * names when it creates a session. That registry cannot stream them: each session replaces this
 * registration with the extension's own, which runs Claude Code and keeps only the models the
 * signed-in account offers. Without an `apiKey`, Pi reports the models available only while the
 * registry's auth storage holds a `claude-code` credential.
 */
export function claudeCodeHostProvider(settings: ClaudeCodeSettings = {}): ProviderConfig {
  return {
    name: 'Claude Code',
    baseUrl: 'claude-code',
    api: 'claude-code',
    models: applyLongContext(CLAUDE_CODE_MODELS, longContextSettings(settings)),
  };
}
