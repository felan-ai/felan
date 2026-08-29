import { configField, defineExtensionConfig } from '@felan-ai/agent-core';

export const TASKS_DISPLAY_MODES = ['inline', 'overlay'] as const;
export type TasksDisplayMode = typeof TASKS_DISPLAY_MODES[number];

export const DEFAULT_TASKS_DISPLAY_MODE: TasksDisplayMode = 'inline';

export const TASKS_CONFIG = defineExtensionConfig({
  id: 'tasks',
  title: 'Tasks',
  fields: {
    displayMode: configField.enum(TASKS_DISPLAY_MODES, {
      default: DEFAULT_TASKS_DISPLAY_MODE,
      label: 'Display mode',
      description: 'Render session tasks inline or in a centered overlay',
    }),
  },
});
