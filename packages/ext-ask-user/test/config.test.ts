import { resolveExtensionConfigs } from '@felan-ai/agent-core';
import { describe, expect, it } from 'vitest';
import {
  ASK_USER_CONFIG,
  DEFAULT_ASK_USER_CONFIG,
  askUserConfigFromSettings,
} from '../src/index.js';

describe('Ask User configuration', () => {
  it('declares the requested defaults', () => {
    expect(resolveExtensionConfigs([ASK_USER_CONFIG]).get('askUser')).toEqual(DEFAULT_ASK_USER_CONFIG);
  });

  it('resolves display, layout, and shortcut overrides', () => {
    expect(askUserConfigFromSettings({
      displayMode: 'overlay',
      singleSelectLayout: 'list',
      overlayToggleKey: ' Alt+O ',
      commentToggleKey: 'off',
    })).toEqual({
      displayMode: 'overlay',
      singleSelectLayout: 'list',
      overlayToggleKey: ' Alt+O ',
      commentToggleKey: 'off',
    });
  });

  it('rejects invalid values', () => {
    expect(() => askUserConfigFromSettings({ displayMode: 'modal' })).toThrow('must be one of');
    expect(() => askUserConfigFromSettings({ overlayToggleKey: 'alt++o' })).toThrow('must be a key or chord');
  });
});
