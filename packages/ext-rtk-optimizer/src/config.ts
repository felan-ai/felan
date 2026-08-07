import type { AgentRuntime } from '@felan-ai/agent-core';
import { joinRuntimePath } from './runtime-path.js';
import {
  DEFAULT_RTK_OPTIMIZER_CONFIG,
  RTK_MODES,
  RTK_SOURCE_FILTER_LEVELS,
  type RtkOptimizerConfig,
  type RtkOutputCompactionConfig,
} from './types.js';

export const RTK_OPTIMIZER_CONFIG_DIRECTORY = 'rtk-optimizer';
export const RTK_OPTIMIZER_CONFIG_FILE = `${RTK_OPTIMIZER_CONFIG_DIRECTORY}/config.json`;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface RtkOptimizerConfigLoadResult {
  readonly config: RtkOptimizerConfig;
  readonly warning?: string;
}

export async function loadRtkOptimizerConfig(runtime: AgentRuntime): Promise<RtkOptimizerConfigLoadResult> {
  const storage = runtime.storage('agent');
  let content: Uint8Array;
  try {
    content = await storage.readFile(RTK_OPTIMIZER_CONFIG_FILE);
  } catch (error) {
    if (!isNotFoundError(error)) {
      return {
        config: cloneDefaultConfig(),
        warning: `Failed to read ${getRtkOptimizerConfigPath(runtime)}: ${errorMessage(error)}`,
      };
    }

    const config = cloneDefaultConfig();
    try {
      await writeConfig(runtime, config);
      return { config };
    } catch (writeError) {
      return {
        config,
        warning: `Failed to create ${getRtkOptimizerConfigPath(runtime)}: ${errorMessage(writeError)}`,
      };
    }
  }

  try {
    const parsed = JSON.parse(decoder.decode(content)) as unknown;
    return { config: validateRtkOptimizerConfig(parsed, getRtkOptimizerConfigPath(runtime)) };
  } catch (error) {
    return {
      config: cloneDefaultConfig(),
      warning: `Invalid ${getRtkOptimizerConfigPath(runtime)}: ${errorMessage(error)}`,
    };
  }
}

export async function saveRtkOptimizerConfig(
  runtime: AgentRuntime,
  config: RtkOptimizerConfig,
): Promise<RtkOptimizerConfig> {
  const normalized = validateRtkOptimizerConfig(config);
  await writeConfig(runtime, normalized);
  return normalized;
}

export function getRtkOptimizerConfigPath(runtime: AgentRuntime): string {
  return joinRuntimePath(runtime.storage('agent').root, RTK_OPTIMIZER_CONFIG_FILE);
}

export function validateRtkOptimizerConfig(value: unknown, source = 'RTK optimizer config'): RtkOptimizerConfig {
  const config = optionalObject(value, source);
  assertKnownKeys(config, source, [
    'enabled',
    'mode',
    'guardWhenRtkMissing',
    'showRewriteNotifications',
    'outputCompaction',
  ]);

  const outputSource = optionalObject(config.outputCompaction, `${source}.outputCompaction`);
  assertKnownKeys(outputSource, `${source}.outputCompaction`, [
    'enabled',
    'stripAnsi',
    'readCompaction',
    'truncate',
    'sourceCodeFilteringEnabled',
    'preserveExactSkillReads',
    'sourceCodeFiltering',
    'smartTruncate',
    'aggregateTestOutput',
    'filterBuildOutput',
    'compactGitOutput',
    'aggregateLinterOutput',
    'groupSearchOutput',
    'trackSavings',
  ]);

  const readSource = optionalObject(outputSource.readCompaction, `${source}.outputCompaction.readCompaction`);
  assertKnownKeys(readSource, `${source}.outputCompaction.readCompaction`, ['enabled']);

  const truncateSource = optionalObject(outputSource.truncate, `${source}.outputCompaction.truncate`);
  assertKnownKeys(truncateSource, `${source}.outputCompaction.truncate`, ['enabled', 'maxChars']);

  const smartTruncateSource = optionalObject(outputSource.smartTruncate, `${source}.outputCompaction.smartTruncate`);
  assertKnownKeys(smartTruncateSource, `${source}.outputCompaction.smartTruncate`, ['enabled', 'maxLines']);

  const defaults = DEFAULT_RTK_OPTIMIZER_CONFIG;
  const outputDefaults = defaults.outputCompaction;
  const outputCompaction: RtkOutputCompactionConfig = {
    enabled: optionalBoolean(outputSource.enabled, outputDefaults.enabled, `${source}.outputCompaction.enabled`),
    stripAnsi: optionalBoolean(
      outputSource.stripAnsi,
      outputDefaults.stripAnsi,
      `${source}.outputCompaction.stripAnsi`,
    ),
    readCompaction: {
      enabled: optionalBoolean(
        readSource.enabled,
        outputDefaults.readCompaction.enabled,
        `${source}.outputCompaction.readCompaction.enabled`,
      ),
    },
    truncate: {
      enabled: optionalBoolean(
        truncateSource.enabled,
        outputDefaults.truncate.enabled,
        `${source}.outputCompaction.truncate.enabled`,
      ),
      maxChars: optionalInteger(
        truncateSource.maxChars,
        outputDefaults.truncate.maxChars,
        1_000,
        200_000,
        `${source}.outputCompaction.truncate.maxChars`,
      ),
    },
    sourceCodeFilteringEnabled: optionalBoolean(
      outputSource.sourceCodeFilteringEnabled,
      outputDefaults.sourceCodeFilteringEnabled,
      `${source}.outputCompaction.sourceCodeFilteringEnabled`,
    ),
    preserveExactSkillReads: optionalBoolean(
      outputSource.preserveExactSkillReads,
      outputDefaults.preserveExactSkillReads,
      `${source}.outputCompaction.preserveExactSkillReads`,
    ),
    sourceCodeFiltering: optionalEnum(
      outputSource.sourceCodeFiltering,
      outputDefaults.sourceCodeFiltering,
      RTK_SOURCE_FILTER_LEVELS,
      `${source}.outputCompaction.sourceCodeFiltering`,
    ),
    smartTruncate: {
      enabled: optionalBoolean(
        smartTruncateSource.enabled,
        outputDefaults.smartTruncate.enabled,
        `${source}.outputCompaction.smartTruncate.enabled`,
      ),
      maxLines: optionalInteger(
        smartTruncateSource.maxLines,
        outputDefaults.smartTruncate.maxLines,
        40,
        4_000,
        `${source}.outputCompaction.smartTruncate.maxLines`,
      ),
    },
    aggregateTestOutput: optionalBoolean(
      outputSource.aggregateTestOutput,
      outputDefaults.aggregateTestOutput,
      `${source}.outputCompaction.aggregateTestOutput`,
    ),
    filterBuildOutput: optionalBoolean(
      outputSource.filterBuildOutput,
      outputDefaults.filterBuildOutput,
      `${source}.outputCompaction.filterBuildOutput`,
    ),
    compactGitOutput: optionalBoolean(
      outputSource.compactGitOutput,
      outputDefaults.compactGitOutput,
      `${source}.outputCompaction.compactGitOutput`,
    ),
    aggregateLinterOutput: optionalBoolean(
      outputSource.aggregateLinterOutput,
      outputDefaults.aggregateLinterOutput,
      `${source}.outputCompaction.aggregateLinterOutput`,
    ),
    groupSearchOutput: optionalBoolean(
      outputSource.groupSearchOutput,
      outputDefaults.groupSearchOutput,
      `${source}.outputCompaction.groupSearchOutput`,
    ),
    trackSavings: optionalBoolean(
      outputSource.trackSavings,
      outputDefaults.trackSavings,
      `${source}.outputCompaction.trackSavings`,
    ),
  };

  return {
    enabled: optionalBoolean(config.enabled, defaults.enabled, `${source}.enabled`),
    mode: optionalEnum(config.mode, defaults.mode, RTK_MODES, `${source}.mode`),
    guardWhenRtkMissing: optionalBoolean(
      config.guardWhenRtkMissing,
      defaults.guardWhenRtkMissing,
      `${source}.guardWhenRtkMissing`,
    ),
    showRewriteNotifications: optionalBoolean(
      config.showRewriteNotifications,
      defaults.showRewriteNotifications,
      `${source}.showRewriteNotifications`,
    ),
    outputCompaction,
  };
}

async function writeConfig(runtime: AgentRuntime, config: RtkOptimizerConfig): Promise<void> {
  const storage = runtime.storage('agent');
  await storage.mkdir(RTK_OPTIMIZER_CONFIG_DIRECTORY, { recursive: true });
  await storage.writeFile(RTK_OPTIMIZER_CONFIG_FILE, encoder.encode(`${JSON.stringify(config, null, 2)}\n`));
}

function optionalObject(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalBoolean(value: unknown, fallback: boolean, path: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
  return value;
}

function optionalInteger(value: unknown, fallback: number, minimum: number, maximum: number, path: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${path} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function optionalEnum<T extends string>(value: unknown, fallback: T, allowed: readonly T[], path: string): T {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${path} must be ${formatAlternatives(allowed)}`);
  }
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

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function cloneDefaultConfig(): RtkOptimizerConfig {
  return structuredClone(DEFAULT_RTK_OPTIMIZER_CONFIG);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
