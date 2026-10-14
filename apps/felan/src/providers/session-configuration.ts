import { createHash } from 'node:crypto';
import type { ExtensionConfigDefinition, ExtensionConfigValue, SettingsManager } from '@felan-ai/agent-core';

const settingKeys = ['defaultProvider', 'defaultModel', 'defaultThinkingLevel', 'modelThinkingLevels',
  'transport', 'steeringMode', 'followUpMode', 'compaction', 'branchSummary', 'retry', 'images', 'cacheWarming', 'enableSkillCommands',
  'enabledModels', 'defaultTools', 'thinkingBudgets', 'codemode', 'felanClassifier', 'felanThinking',
  'felanSubagents', 'outputStyle', 'piExtensions'] as const;

export function localSessionConfiguration(options: {
  settings: SettingsManager;
  packages: readonly string[];
  definitions: readonly ExtensionConfigDefinition[];
  configs: ReadonlyMap<string, Readonly<Record<string, ExtensionConfigValue>>>;
  models: readonly { readonly provider: string; readonly id: string }[];
  paths: readonly string[];
  skills: readonly string[];
  append: string | undefined;
}): { version: 1; digest: string } {
  const settings = options.settings.getSettings() as Record<string, unknown>;
  const executionSettings = Object.fromEntries(settingKeys.flatMap(key => settings[key] === undefined ? [] : [[key, settings[key]]]));
  const configs = Object.fromEntries([...options.configs].sort(([a], [b]) => a.localeCompare(b)).map(([id, values]) => {
    const definition = options.definitions.find(definition => definition.id === id);
    return [id, Object.fromEntries(Object.entries(values).filter(([key]) => !definition?.fields[key]?.sensitive))];
  }));
  const configuration = { settings: executionSettings, packages: options.packages, configs, models: options.models,
    paths: options.paths, skills: options.skills, append: options.append ?? null };
  return { version: 1, digest: createHash('sha256').update(canonical(configuration)).digest('hex') };
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)!;
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}
