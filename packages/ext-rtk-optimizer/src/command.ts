import type { ExtensionContext, FelanExtensionAPI } from '@felan-ai/agent-core';
import type { RtkOptimizerConfig, RuntimeStatus } from './types.js';

export interface RtkOptimizerController {
  getConfig(): RtkOptimizerConfig;
  getRuntimeStatus(): RuntimeStatus;
  refreshRuntimeStatus(): Promise<RuntimeStatus>;
  install(onStatus: (message: string) => void): Promise<RuntimeStatus>;
}

const USAGE = 'Usage: /rtk [show|verify|install|help]';
const SUBCOMMANDS = [
  ['show', 'Show current RTK configuration and runtime status'],
  ['verify', 'Check whether rtk is available in the runtime'],
  ['install', 'Run the pinned official RTK installer'],
  ['help', 'Show command usage'],
] as const;

export function registerRtkCommand(pi: FelanExtensionAPI, controller: RtkOptimizerController): void {
  pi.registerCommand('rtk', {
    description: 'Configure RTK rewriting and output compaction',
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trimStart().toLowerCase();
      if (normalized.includes(' ')) return null;
      const matches = SUBCOMMANDS.filter(([name]) => name.startsWith(normalized));
      return matches.length === 0
        ? null
        : matches.map(([name, description]) => ({ value: name, label: name, description }));
    },
    handler: async (args, ctx) => {
      const subcommand = args.trim().toLowerCase();
      if (!subcommand) {
        ctx.ui.notify('Configure RTK through /settings. Use /rtk show to inspect the resolved settings.', 'info');
        return;
      }

      if (subcommand === 'help') {
        ctx.ui.notify(USAGE, 'info');
      } else if (subcommand === 'show') {
        ctx.ui.notify(formatSummary(controller.getConfig(), controller.getRuntimeStatus()), 'info');
      } else if (subcommand === 'verify') {
        const status = await controller.refreshRuntimeStatus();
        ctx.ui.notify(
          status.rtkAvailable
            ? `RTK is available${status.version ? ` (${status.version})` : ''}.`
            : `RTK is unavailable${status.lastError ? `: ${status.lastError}` : '.'}`,
          status.rtkAvailable ? 'info' : 'warning',
        );
      } else if (subcommand === 'install') {
        ctx.ui.setStatus('rtk-install', '… Installing RTK');
        try {
          const status = await controller.install((message) => {
            ctx.ui.setStatus('rtk-install', `… ${message}`);
          });
          ctx.ui.notify(
            status.rtkAvailable
              ? `RTK installed successfully${status.version ? ` (${status.version})` : ''}.`
              : `RTK installation failed${status.lastError ? `: ${status.lastError}` : '.'}`,
            status.rtkAvailable ? 'info' : 'error',
          );
        } finally {
          ctx.ui.setStatus('rtk-install', undefined);
        }
      } else {
        ctx.ui.notify(USAGE, 'warning');
      }
    },
  });
}

function formatSummary(config: RtkOptimizerConfig, status: RuntimeStatus): string {
  const runtime = status.rtkAvailable
    ? `available${status.version ? ` (${status.version})` : ''}`
    : `missing${status.lastError ? ` (${status.lastError})` : ''}`;
  return [
    `enabled=${config.enabled}`,
    `mode=${config.mode}`,
    `rtk=${runtime}`,
    `compaction=${config.outputCompaction.enabled}`,
    `readCompaction=${config.outputCompaction.readCompaction.enabled}`,
    `sourceFilter=${config.outputCompaction.sourceCodeFiltering}`,
    'commandTools=bash,exec_command,write_stdin',
  ].join(', ');
}
