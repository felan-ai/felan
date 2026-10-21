import { isAbsolute } from 'node:path';
import { configField, defineExtensionConfig, resolveExtensionConfigs } from '@felan-ai/agent-core';
import type { ClaudeCodeSettings } from './bridge/config.js';

export const CLAUDE_CODE_CONFIG = defineExtensionConfig({
  id: 'claude-code',
  title: 'Claude Code',
  fields: {
    plan: configField.enum(['pro', 'max'], {
      default: 'pro',
      description: 'Claude plan used to determine long-context model availability',
    }),
    longContextExtraUsage: configField.boolean({
      default: false,
      description: 'Enable long-context models that may be billed through Claude Extra Usage',
    }),
    forceTwoHundredK: configField.json({
      default: [] as string[],
      description: 'Model IDs to limit to 200K context, without the provider prefix or [1m] suffix',
      validate: (value) => Array.isArray(value) && value.every((id) => typeof id === 'string')
        ? undefined
        : 'must be an array of strings',
    }),
    strictMcpConfig: configField.boolean({
      default: true,
      description: 'Block local Claude Code MCP configurations; use only Felan tools',
    }),
    autoMemoryEnabled: configField.boolean({
      default: false,
      description: 'Enable Claude Code auto-memory in addition to Felan memory',
    }),
    pathToClaudeCodeExecutable: {
      type: 'string',
      optional: true,
      default: undefined,
      description: 'Absolute path to a Claude Code executable instead of the SDK-bundled binary',
      validate: (value: unknown) => typeof value === 'string' && isAbsolute(value) && !value.includes('\0')
        ? undefined
        : 'must be an absolute path',
    },
    inheritAnthropicEnvironment: configField.boolean({
      default: false,
      description: 'Inherit exported ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL; otherwise remove them from Claude Code’s environment to use the Claude plan login',
    }),
  },
});

export function claudeCodeSettingsFromConfig(values: Readonly<Record<string, unknown>>): ClaudeCodeSettings {
  const resolved = resolveExtensionConfigs([CLAUDE_CODE_CONFIG], [{
    extensionId: CLAUDE_CODE_CONFIG.id,
    source: 'Claude Code settings',
    values,
  }]).get(CLAUDE_CODE_CONFIG.id)!;
  return {
    plan: resolved.plan as ClaudeCodeSettings['plan'],
    longContextExtraUsage: resolved.longContextExtraUsage as boolean,
    forceTwoHundredK: [...resolved.forceTwoHundredK as string[]],
    strictMcpConfig: resolved.strictMcpConfig as boolean,
    autoMemoryEnabled: resolved.autoMemoryEnabled as boolean,
    ...(resolved.pathToClaudeCodeExecutable === undefined
      ? {}
      : { pathToClaudeCodeExecutable: resolved.pathToClaudeCodeExecutable as string }),
    inheritAnthropicEnvironment: resolved.inheritAnthropicEnvironment as boolean,
  };
}
