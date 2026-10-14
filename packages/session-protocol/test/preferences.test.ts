import { expect, it } from 'vitest';
import { ConfigValuesSchema, TuiPreferencesSchema, TuiPreferencesUpdateSchema, parseSchema } from '../src/index.js';

it('keeps client themes out of daemon preferences', () => {
  const preferences = { hideThinking: false, showImages: true, imageWidthCells: 60, outputPad: 1, toolDisplay: 'grouped', keybindings: {} };
  expect(parseSchema(TuiPreferencesSchema, preferences)).toEqual(preferences);
  expect(() => parseSchema(TuiPreferencesSchema, { ...preferences, theme: 'client-theme' })).toThrow();
  expect(() => parseSchema(TuiPreferencesUpdateSchema, { theme: 'client-theme' })).toThrow();
  expect(() => parseSchema(TuiPreferencesUpdateSchema, { hideThinking: true, theme: 'client-theme' })).toThrow();
});

it('validates client terminal controls and keeps execution image policy in configuration', () => {
  const controls = { hardwareCursor: true, editorPadding: 3, autocompleteMaxVisible: 20, clearOnShrink: true, terminalProgress: false };
  expect(parseSchema(TuiPreferencesUpdateSchema, controls)).toEqual(controls);
  for (const invalid of [{ editorPadding: -1 }, { editorPadding: 4 }, { autocompleteMaxVisible: 2 }, { autocompleteMaxVisible: 21 }, { terminalProgress: 'true' }, { blockImages: true }]) {
    expect(() => parseSchema(TuiPreferencesUpdateSchema, invalid)).toThrow();
  }
  expect(parseSchema(ConfigValuesSchema, { imageAutoResize: false, blockImages: true })).toEqual({ imageAutoResize: false, blockImages: true });
  expect(() => parseSchema(ConfigValuesSchema, { imageAutoResize: 'false' })).toThrow();
});
