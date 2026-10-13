export const builtinExtensionPackages = {
  subagents: '@felan-ai/ext-subagents',
  askUser: '@felan-ai/ext-ask-user',
  tasks: '@felan-ai/ext-tasks',
  prewalk: '@felan-ai/ext-prewalk',
  mcp: '@felan-ai/ext-mcp',
  felanApi: '@felan-ai/ext-felan-api',
  modelTools: '@felan-ai/ext-model-tools',
  fusion: '@felan-ai/ext-fusion',
  webAccess: '@felan-ai/ext-web-access',
  browser: '@felan-ai/ext-browser',
  backgroundBash: '@felan-ai/ext-background-bash',
  codex: '@felan-ai/ext-codex',
  sessionCompaction: '@felan-ai/ext-session-compaction',
  rtkOptimizer: '@felan-ai/ext-rtk-optimizer',
  codebaseMemory: '@felan-ai/ext-codebase-memory',
  markitdown: '@felan-ai/ext-markitdown',
  context: '@felan-ai/ext-context',
  contextView: '@felan-ai/ext-context-view',
  insights: '@felan-ai/ext-insights',
  memory: '@felan-ai/ext-memory',
  powerline: '@felan-ai/ext-powerline',
  outputStyle: '@felan-ai/ext-output-style',
  promptHistory: '@felan-ai/ext-prompt-history',
  sessionTitle: '@felan-ai/ext-session-title',
} as const;

export type BuiltinExtensionName = keyof typeof builtinExtensionPackages;
export type BuiltinExtensionSettings = Partial<Record<BuiltinExtensionName, boolean>>;

export function validateBuiltinExtensionKeys(settings: unknown): asserts settings is BuiltinExtensionSettings | undefined {
  if (settings === undefined) return;
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) throw new Error('builtinExtensions must be an object');
  for (const [name, enabled] of Object.entries(settings)) {
    if (!Object.hasOwn(builtinExtensionPackages, name)) throw new Error(`Unknown built-in extension: ${name}`);
    if (typeof enabled !== 'boolean') throw new Error(`Built-in extension ${name} must be a boolean`);
  }
}
