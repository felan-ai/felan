import type { ExtensionPackageImporter } from '@felan-ai/agent-core';

export const askUserExtensionPackage = '@felan-ai/ext-ask-user';
export const mcpExtensionPackage = '@felan-ai/ext-mcp';
export const felanApiExtensionPackage = '@felan-ai/ext-felan-api';
export const powerlineExtensionPackage = '@felan-ai/ext-powerline';
export const subagentsExtensionPackage = '@felan-ai/ext-subagents';
export const memoryExtensionPackage = '@felan-ai/ext-memory';
export const modelToolsExtensionPackage = '@felan-ai/ext-model-tools';
export const fusionExtensionPackage = '@felan-ai/ext-fusion';
export const outputStyleExtensionPackage = '@felan-ai/ext-output-style';
export const insightsExtensionPackage = '@felan-ai/ext-insights';
export const promptHistoryExtensionPackage = '@felan-ai/ext-prompt-history';
export const sessionTitleExtensionPackage = '@felan-ai/ext-session-title';
export const sessionCompactionExtensionPackage = '@felan-ai/ext-session-compaction';
export const builtinExtensionPackages = {
  subagents: subagentsExtensionPackage,
  askUser: askUserExtensionPackage,
  tasks: '@felan-ai/ext-tasks',
  prewalk: '@felan-ai/ext-prewalk',
  mcp: mcpExtensionPackage,
  felanApi: felanApiExtensionPackage,
  modelTools: modelToolsExtensionPackage,
  fusion: fusionExtensionPackage,
  webAccess: '@felan-ai/ext-web-access',
  browser: '@felan-ai/ext-browser',
  backgroundBash: '@felan-ai/ext-background-bash',
  codex: '@felan-ai/ext-codex',
  sessionCompaction: sessionCompactionExtensionPackage,
  rtkOptimizer: '@felan-ai/ext-rtk-optimizer',
  codebaseMemory: '@felan-ai/ext-codebase-memory',
  // Append conversion diagnostics after result optimization, then restore the source path for progressive context.
  markitdown: '@felan-ai/ext-markitdown',
  context: '@felan-ai/ext-context',
  contextView: '@felan-ai/ext-context-view',
  insights: insightsExtensionPackage,
  memory: memoryExtensionPackage,
  powerline: powerlineExtensionPackage,
  outputStyle: outputStyleExtensionPackage,
  promptHistory: promptHistoryExtensionPackage,
  sessionTitle: sessionTitleExtensionPackage,
} as const;
export const localExtensionPackages = Object.values(builtinExtensionPackages);

export type BuiltinExtensionName = keyof typeof builtinExtensionPackages;
export type BuiltinExtensionSettings = Partial<Record<BuiltinExtensionName, boolean>>;

const localExtensionPackageSet: ReadonlySet<string> = new Set(localExtensionPackages);

export function resolveBuiltinExtensionPackages(settings: unknown): readonly string[] {
  if (settings === undefined) return localExtensionPackages;
  if (!isRecord(settings)) throw new Error('builtinExtensions must be an object');

  for (const [name, enabled] of Object.entries(settings)) {
    if (!Object.hasOwn(builtinExtensionPackages, name)) throw new Error(`Unknown built-in extension: ${name}`);
    if (typeof enabled !== 'boolean') throw new Error(`Built-in extension ${name} must be a boolean`);
  }

  return Object.entries(builtinExtensionPackages)
    .filter(([name]) => settings[name] !== false)
    .map(([, packageName]) => packageName);
}

export const importLocalExtension: ExtensionPackageImporter = async (packageName) => {
  if (!localExtensionPackageSet.has(packageName)) {
    throw new Error(`Unknown local extension package: ${packageName}`);
  }
  if (packageName === builtinExtensionPackages.codex) return import('@felan-ai/ext-codex/runtime');
  if (packageName === builtinExtensionPackages.codebaseMemory) return import('@felan-ai/ext-codebase-memory/runtime');
  if (packageName === powerlineExtensionPackage) return import('@felan-ai/ext-powerline/runtime');
  return import(packageName);
};


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
