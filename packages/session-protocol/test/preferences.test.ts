import { expect, it } from 'vitest';
import { TuiPreferencesSchema, TuiPreferencesUpdateSchema, parseSchema } from '../src/index.js';

it('keeps client themes out of daemon preferences', () => {
  const preferences = { hideThinking: false, showImages: true, imageWidthCells: 60, outputPad: 1, toolDisplay: 'grouped', keybindings: {} };
  expect(parseSchema(TuiPreferencesSchema, preferences)).toEqual(preferences);
  expect(() => parseSchema(TuiPreferencesSchema, { ...preferences, theme: 'client-theme' })).toThrow();
  expect(() => parseSchema(TuiPreferencesUpdateSchema, { theme: 'client-theme' })).toThrow();
  expect(() => parseSchema(TuiPreferencesUpdateSchema, { hideThinking: true, theme: 'client-theme' })).toThrow();
});
