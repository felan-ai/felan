import { configField, defineExtensionConfig } from '@felan-ai/agent-core';
import {
  DEFAULT_RTK_OPTIMIZER_CONFIG,
  RTK_MODES,
  RTK_SOURCE_FILTER_LEVELS,
  type RtkOptimizerConfig,
  type RtkOutputCompactionConfig,
} from './types.js';

export const RTK_OPTIMIZER_CONFIG = defineExtensionConfig({
  id: 'rtkOptimizer',
  title: 'RTK optimizer',
  fields: {
    enabled: configField.boolean({ default: true, description: 'Enable RTK command rewriting and compaction' }),
    mode: configField.enum(RTK_MODES, { default: 'rewrite', description: 'Rewrite commands or only suggest rewrites' }),
    guardWhenRtkMissing: configField.boolean({ default: true, description: 'Bypass RTK when the executable is unavailable' }),
    showRewriteNotifications: configField.boolean({ default: true, description: 'Show rewrite notifications' }),
    compactionEnabled: configField.boolean({ default: true, description: 'Enable output compaction' }),
    stripAnsi: configField.boolean({ default: true, description: 'Strip ANSI sequences from command output' }),
    readCompaction: configField.boolean({ default: false, description: 'Enable lossy read compaction' }),
    truncate: configField.boolean({ default: true, description: 'Enable hard output truncation' }),
    truncateMaxChars: configField.number({ default: 12_000, description: 'Maximum characters after truncation', validate: integerRange(1_000, 200_000) }),
    sourceCodeFilteringEnabled: configField.boolean({ default: false, description: 'Enable source-code filtering' }),
    preserveExactSkillReads: configField.boolean({ default: false, description: 'Preserve exact skill reads' }),
    sourceFiltering: configField.enum(RTK_SOURCE_FILTER_LEVELS, { default: 'none', description: 'Source-code filtering level' }),
    smartTruncate: configField.boolean({ default: false, description: 'Enable smart truncation' }),
    smartTruncateMaxLines: configField.number({ default: 220, description: 'Maximum lines for smart truncation', validate: integerRange(40, 4_000) }),
    aggregateTestOutput: configField.boolean({ default: true, description: 'Aggregate test output' }),
    filterBuildOutput: configField.boolean({ default: true, description: 'Filter build output' }),
    compactGitOutput: configField.boolean({ default: true, description: 'Compact Git output' }),
    aggregateLinterOutput: configField.boolean({ default: true, description: 'Aggregate linter output' }),
    groupSearchOutput: configField.boolean({ default: true, description: 'Group search output' }),
    trackSavings: configField.boolean({ default: true, description: 'Track output savings' }),
  },
});

export function rtkOptimizerConfigFromSettings(
  values: Readonly<Record<string, unknown>>,
): RtkOptimizerConfig {
  const defaults = DEFAULT_RTK_OPTIMIZER_CONFIG;
  const outputDefaults = defaults.outputCompaction;
  const get = (name: string, fallback: unknown): unknown => values[name] ?? fallback;
  return {
    enabled: get('enabled', defaults.enabled) as boolean,
    mode: get('mode', defaults.mode) as RtkOptimizerConfig['mode'],
    guardWhenRtkMissing: get('guardWhenRtkMissing', defaults.guardWhenRtkMissing) as boolean,
    showRewriteNotifications: get('showRewriteNotifications', defaults.showRewriteNotifications) as boolean,
    outputCompaction: {
      enabled: get('compactionEnabled', outputDefaults.enabled) as boolean,
      stripAnsi: get('stripAnsi', outputDefaults.stripAnsi) as boolean,
      readCompaction: { enabled: get('readCompaction', outputDefaults.readCompaction.enabled) as boolean },
      truncate: {
        enabled: get('truncate', outputDefaults.truncate.enabled) as boolean,
        maxChars: get('truncateMaxChars', outputDefaults.truncate.maxChars) as number,
      },
      sourceCodeFilteringEnabled: get('sourceCodeFilteringEnabled', outputDefaults.sourceCodeFilteringEnabled) as boolean,
      preserveExactSkillReads: get('preserveExactSkillReads', outputDefaults.preserveExactSkillReads) as boolean,
      sourceCodeFiltering: get('sourceFiltering', outputDefaults.sourceCodeFiltering) as RtkOutputCompactionConfig['sourceCodeFiltering'],
      smartTruncate: {
        enabled: get('smartTruncate', outputDefaults.smartTruncate.enabled) as boolean,
        maxLines: get('smartTruncateMaxLines', outputDefaults.smartTruncate.maxLines) as number,
      },
      aggregateTestOutput: get('aggregateTestOutput', outputDefaults.aggregateTestOutput) as boolean,
      filterBuildOutput: get('filterBuildOutput', outputDefaults.filterBuildOutput) as boolean,
      compactGitOutput: get('compactGitOutput', outputDefaults.compactGitOutput) as boolean,
      aggregateLinterOutput: get('aggregateLinterOutput', outputDefaults.aggregateLinterOutput) as boolean,
      groupSearchOutput: get('groupSearchOutput', outputDefaults.groupSearchOutput) as boolean,
      trackSavings: get('trackSavings', outputDefaults.trackSavings) as boolean,
    },
  };
}

export function validateRtkOptimizerConfig(value: unknown, source = 'RTK optimizer config'): RtkOptimizerConfig {
  const config = optionalObject(value, source);
  assertKnownKeys(config, source, ['enabled', 'mode', 'guardWhenRtkMissing', 'showRewriteNotifications', 'outputCompaction']);
  const outputSource = optionalObject(config.outputCompaction, `${source}.outputCompaction`);
  assertKnownKeys(outputSource, `${source}.outputCompaction`, [
    'enabled', 'stripAnsi', 'readCompaction', 'truncate', 'sourceCodeFilteringEnabled',
    'preserveExactSkillReads', 'sourceCodeFiltering', 'smartTruncate', 'aggregateTestOutput',
    'filterBuildOutput', 'compactGitOutput', 'aggregateLinterOutput', 'groupSearchOutput', 'trackSavings',
  ]);
  const readSource = optionalObject(outputSource.readCompaction, `${source}.outputCompaction.readCompaction`);
  const truncateSource = optionalObject(outputSource.truncate, `${source}.outputCompaction.truncate`);
  const smartSource = optionalObject(outputSource.smartTruncate, `${source}.outputCompaction.smartTruncate`);
  assertKnownKeys(readSource, `${source}.outputCompaction.readCompaction`, ['enabled']);
  assertKnownKeys(truncateSource, `${source}.outputCompaction.truncate`, ['enabled', 'maxChars']);
  assertKnownKeys(smartSource, `${source}.outputCompaction.smartTruncate`, ['enabled', 'maxLines']);
  const defaults = DEFAULT_RTK_OPTIMIZER_CONFIG;
  const outputDefaults = defaults.outputCompaction;
  return {
    enabled: optionalBoolean(config.enabled, defaults.enabled, `${source}.enabled`),
    mode: optionalEnum(config.mode, defaults.mode, RTK_MODES, `${source}.mode`),
    guardWhenRtkMissing: optionalBoolean(config.guardWhenRtkMissing, defaults.guardWhenRtkMissing, `${source}.guardWhenRtkMissing`),
    showRewriteNotifications: optionalBoolean(config.showRewriteNotifications, defaults.showRewriteNotifications, `${source}.showRewriteNotifications`),
    outputCompaction: {
      enabled: optionalBoolean(outputSource.enabled, outputDefaults.enabled, `${source}.outputCompaction.enabled`),
      stripAnsi: optionalBoolean(outputSource.stripAnsi, outputDefaults.stripAnsi, `${source}.outputCompaction.stripAnsi`),
      readCompaction: { enabled: optionalBoolean(readSource.enabled, outputDefaults.readCompaction.enabled, `${source}.outputCompaction.readCompaction.enabled`) },
      truncate: {
        enabled: optionalBoolean(truncateSource.enabled, outputDefaults.truncate.enabled, `${source}.outputCompaction.truncate.enabled`),
        maxChars: optionalInteger(truncateSource.maxChars, outputDefaults.truncate.maxChars, 1_000, 200_000, `${source}.outputCompaction.truncate.maxChars`),
      },
      sourceCodeFilteringEnabled: optionalBoolean(outputSource.sourceCodeFilteringEnabled, outputDefaults.sourceCodeFilteringEnabled, `${source}.outputCompaction.sourceCodeFilteringEnabled`),
      preserveExactSkillReads: optionalBoolean(outputSource.preserveExactSkillReads, outputDefaults.preserveExactSkillReads, `${source}.outputCompaction.preserveExactSkillReads`),
      sourceCodeFiltering: optionalEnum(outputSource.sourceCodeFiltering, outputDefaults.sourceCodeFiltering, RTK_SOURCE_FILTER_LEVELS, `${source}.outputCompaction.sourceCodeFiltering`),
      smartTruncate: {
        enabled: optionalBoolean(smartSource.enabled, outputDefaults.smartTruncate.enabled, `${source}.outputCompaction.smartTruncate.enabled`),
        maxLines: optionalInteger(smartSource.maxLines, outputDefaults.smartTruncate.maxLines, 40, 4_000, `${source}.outputCompaction.smartTruncate.maxLines`),
      },
      aggregateTestOutput: optionalBoolean(outputSource.aggregateTestOutput, outputDefaults.aggregateTestOutput, `${source}.outputCompaction.aggregateTestOutput`),
      filterBuildOutput: optionalBoolean(outputSource.filterBuildOutput, outputDefaults.filterBuildOutput, `${source}.outputCompaction.filterBuildOutput`),
      compactGitOutput: optionalBoolean(outputSource.compactGitOutput, outputDefaults.compactGitOutput, `${source}.outputCompaction.compactGitOutput`),
      aggregateLinterOutput: optionalBoolean(outputSource.aggregateLinterOutput, outputDefaults.aggregateLinterOutput, `${source}.outputCompaction.aggregateLinterOutput`),
      groupSearchOutput: optionalBoolean(outputSource.groupSearchOutput, outputDefaults.groupSearchOutput, `${source}.outputCompaction.groupSearchOutput`),
      trackSavings: optionalBoolean(outputSource.trackSavings, outputDefaults.trackSavings, `${source}.outputCompaction.trackSavings`),
    },
  };
}

function integerRange(minimum: number, maximum: number): (value: unknown) => string | undefined {
  return (value) => Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
    ? undefined
    : `must be an integer from ${minimum} to ${maximum}`;
}

function optionalObject(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}
function optionalBoolean(value: unknown, fallback: boolean, path: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
  return value;
}
function optionalInteger(value: unknown, fallback: number, minimum: number, maximum: number, path: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${path} must be an integer from ${minimum} to ${maximum}`);
  return value as number;
}
function optionalEnum<T extends string>(value: unknown, fallback: T, allowed: readonly T[], path: string): T {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`${path} must be ${formatAlternatives(allowed)}`);
  return value as T;
}
function assertKnownKeys(value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown) throw new Error(`${path} contains unknown field: ${unknown}`);
}
function formatAlternatives(values: readonly string[]): string {
  if (values.length < 2) return values[0] ?? 'a supported value';
  return `${values.slice(0, -1).join(', ')}, or ${values.at(-1)}`;
}
