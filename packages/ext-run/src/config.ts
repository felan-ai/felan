import { configField, defineExtensionConfig } from '@felan-ai/agent-core';

export const DEFAULT_RUN_TOOL_NAMES = [
  'read',
  'grep',
  'find',
  'ls',
  'read_symbol',
  'search_and_read_symbols',
  'search_code',
  'session_recall',
  'TaskList',
  'TaskGet',
  'web_search',
  'fetch_content',
] as const;

export const RUN_CONFIG = defineExtensionConfig({
  id: 'run',
  title: 'Code mode',
  fields: {
    toolNames: configField.json({
      default: [...DEFAULT_RUN_TOOL_NAMES],
      description: 'Exact active tool names exposed to generated code',
      validate: validateToolNames,
    }),
  },
});

export function configuredRunToolNames(value: unknown): readonly string[] {
  if (value === undefined) return DEFAULT_RUN_TOOL_NAMES;
  if (!Array.isArray(value) || value.length > 100 || !value.every(isToolName)) {
    throw new Error('toolNames must be an array of at most 100 non-empty tool names');
  }
  return [...new Set(value)];
}

function validateToolNames(value: unknown): string | undefined {
  try {
    configuredRunToolNames(value);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function isToolName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u.test(value);
}
