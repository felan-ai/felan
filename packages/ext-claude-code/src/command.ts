import { RUNTIME_DEPENDENCIES_SERVICE, type FelanExtensionAPI } from '@felan-ai/agent-core';
import type { ClaudeCodeSettings } from './bridge/config.js';
import { inspectClaudeCodeRuntime } from './managed/index.js';

export interface ClaudeCodeController {
  getSettings(): ClaudeCodeSettings;
  isProviderRegistered(): boolean;
}

const USAGE = 'Usage: /claude-code [status|install]';
const SUBCOMMANDS = [
  ['status', 'Show Claude Agent SDK, provider and plan settings'],
  ['install', 'Install the managed Claude Agent SDK through the local Felan host'],
] as const;

export function registerClaudeCodeCommand(pi: FelanExtensionAPI, controller: ClaudeCodeController): void {
  const dependencies = pi.services.get(RUNTIME_DEPENDENCIES_SERVICE);
  pi.registerCommand('claude-code', {
    description: 'Inspect or install the Claude Code model provider',
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trimStart().toLowerCase();
      if (normalized.includes(' ')) return null;
      const matches = SUBCOMMANDS.filter(([name]) => name.startsWith(normalized));
      return matches.length === 0
        ? null
        : matches.map(([name, description]) => ({ value: name, label: name, description }));
    },
    handler: async (args, ctx) => {
      const notify = async (text: string, level: 'info' | 'warning' | 'error') => {
        await pi.ui.notify({ text, level });
      };
      const subcommand = args.trim().toLowerCase() || 'status';
      if (subcommand === 'status') {
        const status = await inspectClaudeCodeRuntime(pi.runtime);
        const settings = controller.getSettings();
        await notify([
          status.available === true ? `Claude Agent SDK: available (${status.version})` : `Claude Agent SDK: unavailable (${status.reason})`,
          `Provider: ${controller.isProviderRegistered() ? 'registered' : 'not registered'}`,
          `plan=${settings.plan ?? 'pro'}`,
          `longContextExtraUsage=${settings.longContextExtraUsage ?? false}`,
          `forceTwoHundredK=${JSON.stringify(settings.forceTwoHundredK ?? [])}`,
        ].join('\n'), status.available ? 'info' : 'warning');
      } else if (subcommand === 'install') {
        if (!dependencies) {
          await notify('Claude Code installation requires the local Felan host with a runtime-dependencies provider.', 'warning');
          return;
        }
        try {
          const result = await dependencies.install({ id: 'claude-code' }, { signal: ctx.signal });
          await notify(
            result.status === 'installed'
              ? 'Claude Agent SDK installed successfully. Start a new session or reload to load Claude models.'
              : result.message,
            result.status === 'installed' ? 'info' : 'warning',
          );
        } catch (error) {
          if (ctx.signal?.aborted) {
            await notify('Claude Code installation request cancelled.', 'warning');
          } else {
            await notify(`Claude Code installation failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
          }
        }
      } else {
        await notify(USAGE, 'warning');
      }
    },
  });
}
