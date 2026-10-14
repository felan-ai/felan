import { configField, defineExtensionConfig } from '@felan-ai/agent-core';

export const POWERLINE_CONFIG = defineExtensionConfig({
  id: 'powerline', title: 'Powerline', fields: {
    showWorkingTree: configField.boolean({ default: true, description: 'Collect Git working-tree changes' }),
    showStashCount: configField.boolean({ default: false, description: 'Collect Git stash count' }),
    periodDays: configField.number({ default: 7, description: 'Savings query period in days',
      validate: value => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 3650 ? undefined : 'must be an integer from 1 to 3650' }),
    maxWindows: configField.number({ default: 3, description: 'Maximum subscription usage windows',
      validate: value => Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 8 ? undefined : 'must be an integer from 1 to 8' }),
  },
});
