import type { ExtensionContext, FelanExtensionAPI } from '@felan-ai/agent-core';
import { getRtkOptimizerConfigPath } from './config.js';
import { DEFAULT_RTK_OPTIMIZER_CONFIG, type RtkOptimizerConfig, type RuntimeStatus } from './types.js';

export interface RtkOptimizerController {
  getConfig(): RtkOptimizerConfig;
  setConfig(config: RtkOptimizerConfig): Promise<void>;
  getRuntimeStatus(): RuntimeStatus;
  refreshRuntimeStatus(): Promise<RuntimeStatus>;
  install(onStatus: (message: string) => void): Promise<RuntimeStatus>;
  getMetricsSummary(): string;
  clearMetrics(): void;
}

const USAGE = 'Usage: /rtk [show|path|verify|install|stats|clear-stats|reset|help]';
const SUBCOMMANDS = [
  ['show', 'Show current RTK configuration and runtime status'],
  ['path', 'Show the RTK configuration path'],
  ['verify', 'Check whether rtk is available in the runtime'],
  ['install', 'Run the pinned official RTK installer'],
  ['stats', 'Show output-compaction metrics'],
  ['clear-stats', 'Clear output-compaction metrics'],
  ['reset', 'Reset RTK settings to defaults'],
  ['help', 'Show command usage'],
] as const;

type SettingId =
  | 'enabled'
  | 'mode'
  | 'guardWhenRtkMissing'
  | 'showRewriteNotifications'
  | 'compactionEnabled'
  | 'stripAnsi'
  | 'readCompaction'
  | 'sourceFilteringEnabled'
  | 'sourceFiltering'
  | 'preserveExactSkillReads'
  | 'aggregateTestOutput'
  | 'filterBuildOutput'
  | 'compactGitOutput'
  | 'aggregateLinterOutput'
  | 'groupSearchOutput'
  | 'smartTruncate'
  | 'smartTruncateMaxLines'
  | 'truncate'
  | 'truncateMaxChars'
  | 'trackSavings';

interface SettingChoice {
  readonly id: SettingId;
  readonly label: string;
}

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
        if (!ctx.hasUI) {
          ctx.ui.notify('/rtk settings require interactive TUI mode.', 'warning');
          return;
        }
        await openSettings(ctx, controller);
        return;
      }

      if (subcommand === 'help') {
        ctx.ui.notify(USAGE, 'info');
      } else if (subcommand === 'show') {
        ctx.ui.notify(formatSummary(controller.getConfig(), controller.getRuntimeStatus()), 'info');
      } else if (subcommand === 'path') {
        ctx.ui.notify(`RTK config: ${getRtkOptimizerConfigPath(pi.runtime)}`, 'info');
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
      } else if (subcommand === 'stats') {
        ctx.ui.notify(controller.getMetricsSummary(), 'info');
      } else if (subcommand === 'clear-stats') {
        controller.clearMetrics();
        ctx.ui.notify('RTK metrics cleared.', 'info');
      } else if (subcommand === 'reset') {
        if (await saveConfig(ctx, controller, structuredClone(DEFAULT_RTK_OPTIMIZER_CONFIG))) {
          ctx.ui.notify('RTK optimizer settings reset to defaults.', 'info');
        }
      } else {
        ctx.ui.notify(USAGE, 'warning');
      }
    },
  });
}

async function openSettings(ctx: ExtensionContext, controller: RtkOptimizerController): Promise<void> {
  while (true) {
    const config = controller.getConfig();
    const choices = settingChoices(config);
    const close = 'Close RTK settings';
    const selected = await ctx.ui.select('RTK Optimizer settings', [...choices.map((choice) => choice.label), close]);
    if (!selected || selected === close) return;
    const choice = choices.find((candidate) => candidate.label === selected);
    if (!choice) continue;

    const next = await changeSetting(ctx, config, choice.id);
    if (next) await saveConfig(ctx, controller, next);
  }
}

async function changeSetting(
  ctx: ExtensionContext,
  config: RtkOptimizerConfig,
  id: SettingId,
): Promise<RtkOptimizerConfig | undefined> {
  const next = structuredClone(config);
  const output = next.outputCompaction;

  switch (id) {
    case 'enabled':
      next.enabled = !next.enabled;
      break;
    case 'mode':
      next.mode = next.mode === 'rewrite' ? 'suggest' : 'rewrite';
      break;
    case 'guardWhenRtkMissing':
      next.guardWhenRtkMissing = !next.guardWhenRtkMissing;
      break;
    case 'showRewriteNotifications':
      next.showRewriteNotifications = !next.showRewriteNotifications;
      break;
    case 'compactionEnabled':
      output.enabled = !output.enabled;
      break;
    case 'stripAnsi':
      output.stripAnsi = !output.stripAnsi;
      break;
    case 'readCompaction':
      output.readCompaction.enabled = !output.readCompaction.enabled;
      break;
    case 'sourceFilteringEnabled':
      output.sourceCodeFilteringEnabled = !output.sourceCodeFilteringEnabled;
      break;
    case 'preserveExactSkillReads':
      output.preserveExactSkillReads = !output.preserveExactSkillReads;
      break;
    case 'aggregateTestOutput':
      output.aggregateTestOutput = !output.aggregateTestOutput;
      break;
    case 'filterBuildOutput':
      output.filterBuildOutput = !output.filterBuildOutput;
      break;
    case 'compactGitOutput':
      output.compactGitOutput = !output.compactGitOutput;
      break;
    case 'aggregateLinterOutput':
      output.aggregateLinterOutput = !output.aggregateLinterOutput;
      break;
    case 'groupSearchOutput':
      output.groupSearchOutput = !output.groupSearchOutput;
      break;
    case 'smartTruncate':
      output.smartTruncate.enabled = !output.smartTruncate.enabled;
      break;
    case 'truncate':
      output.truncate.enabled = !output.truncate.enabled;
      break;
    case 'trackSavings':
      output.trackSavings = !output.trackSavings;
      break;
    case 'sourceFiltering': {
      const selected = await ctx.ui.select('Read source filtering', ['none', 'minimal', 'aggressive']);
      if (!selected) return undefined;
      output.sourceCodeFiltering = selected as typeof output.sourceCodeFiltering;
      break;
    }
    case 'smartTruncateMaxLines': {
      const selected = await ctx.ui.select('Read smart-truncation maximum lines', [
        '40',
        '80',
        '120',
        '160',
        '220',
        '320',
        '500',
        '1000',
        '2000',
        '4000',
      ]);
      if (!selected) return undefined;
      output.smartTruncate.maxLines = Number.parseInt(selected, 10);
      break;
    }
    case 'truncateMaxChars': {
      const selected = await ctx.ui.select('Hard-truncation maximum characters', [
        '4000',
        '8000',
        '12000',
        '20000',
        '50000',
        '100000',
        '200000',
      ]);
      if (!selected) return undefined;
      output.truncate.maxChars = Number.parseInt(selected, 10);
      break;
    }
  }
  return next;
}

async function saveConfig(
  ctx: ExtensionContext,
  controller: RtkOptimizerController,
  config: RtkOptimizerConfig,
): Promise<boolean> {
  try {
    await controller.setConfig(config);
    return true;
  } catch (error) {
    ctx.ui.notify(`Failed to save RTK settings: ${errorMessage(error)}`, 'error');
    return false;
  }
}

function settingChoices(config: RtkOptimizerConfig): SettingChoice[] {
  const output = config.outputCompaction;
  return [
    setting('enabled', 'Optimizer enabled', onOff(config.enabled)),
    setting('mode', 'Rewrite mode', config.mode),
    setting('guardWhenRtkMissing', 'Guard when RTK is missing', onOff(config.guardWhenRtkMissing)),
    setting('showRewriteNotifications', 'Rewrite notifications', onOff(config.showRewriteNotifications)),
    setting('compactionEnabled', 'Output compaction', onOff(output.enabled)),
    setting('stripAnsi', 'Strip ANSI', onOff(output.stripAnsi)),
    setting('readCompaction', 'Lossy read compaction', onOff(output.readCompaction.enabled)),
    setting('sourceFilteringEnabled', 'Read source filtering', onOff(output.sourceCodeFilteringEnabled)),
    setting('sourceFiltering', 'Read source-filter level', output.sourceCodeFiltering),
    setting('preserveExactSkillReads', 'Preserve exact skill reads', onOff(output.preserveExactSkillReads)),
    setting('aggregateTestOutput', 'Aggregate test output', onOff(output.aggregateTestOutput)),
    setting('filterBuildOutput', 'Filter build output', onOff(output.filterBuildOutput)),
    setting('compactGitOutput', 'Compact Git output', onOff(output.compactGitOutput)),
    setting('aggregateLinterOutput', 'Aggregate linter output', onOff(output.aggregateLinterOutput)),
    setting('groupSearchOutput', 'Group search output', onOff(output.groupSearchOutput)),
    setting('smartTruncate', 'Read smart truncation', onOff(output.smartTruncate.enabled)),
    setting('smartTruncateMaxLines', 'Read smart-truncation lines', String(output.smartTruncate.maxLines)),
    setting('truncate', 'Hard truncation', onOff(output.truncate.enabled)),
    setting('truncateMaxChars', 'Hard-truncation characters', String(output.truncate.maxChars)),
    setting('trackSavings', 'Track savings', onOff(output.trackSavings)),
  ];
}

function setting(id: SettingId, name: string, value: string): SettingChoice {
  return { id, label: `${name}: ${value}` };
}

function onOff(value: boolean): string {
  return value ? 'on' : 'off';
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
