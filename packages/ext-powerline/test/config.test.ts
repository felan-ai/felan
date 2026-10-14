import { expect, it } from 'vitest';
import { resolveExtensionConfigs } from '@felan-ai/agent-core';
import { POWERLINE_CONFIG } from '../src/config.js';

it('declares only data-collection settings', () => {
  expect(resolveExtensionConfigs([POWERLINE_CONFIG]).get('powerline')).toEqual({ showWorkingTree: true, showStashCount: false, periodDays: 7, maxWindows: 3 });
  for (const field of ['style', 'charset', 'autoWrap', 'padding', 'lines']) expect(POWERLINE_CONFIG.fields).not.toHaveProperty(field);
  for (const values of [{ periodDays: 0 }, { periodDays: 3651 }, { maxWindows: 9 }, { showWorkingTree: 'false' }]) {
    expect(() => resolveExtensionConfigs([POWERLINE_CONFIG], [{ extensionId: 'powerline', source: 'test', values }])).toThrow();
  }
});
