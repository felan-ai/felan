import { expect, it } from 'vitest';
import { ConfigValuesSchema, TuiPreferencesUpdateSchema, parseSchema } from '../src/index.js';

it('validates execution defaults without accepting client rendering preferences', () => {
  const defaults = { autoCompact: false, skillCommands: false, steeringMode: 'all', followUpMode: 'one-at-a-time', transport: 'websocket-cached',
    cacheWarming: 'idle', httpIdleTimeoutMs: 0, modelThinkingLevels: { 'offline/model': 'max' } };
  expect(parseSchema(ConfigValuesSchema, defaults)).toEqual(defaults);
  for (const value of [{ autoCompact: 'false' }, { steeringMode: 'none' }, { transport: 'ftp' }, { cacheWarming: 'always' },
    { httpIdleTimeoutMs: -1 }, { httpIdleTimeoutMs: 1.5 }, { httpIdleTimeoutMs: 2147483648 }, { modelThinkingLevels: { 'p/m': 'unlimited' } }, { mermaid: 'off' }]) {
    expect(() => parseSchema(ConfigValuesSchema, value)).toThrow();
  }
});

it('validates rendering preferences without accepting execution defaults', () => {
  const display = { mermaid: 'final', quietStartup: 'header', fullscreenScrollbar: 'always', fullscreenCopyOnSelect: false, fullscreenWheelScrollLines: 'auto' };
  expect(parseSchema(TuiPreferencesUpdateSchema, display)).toEqual(display);
  for (const value of [{ quietStartup: 'yes' }, { mermaid: 'always' }, { fullscreenScrollbar: 'none' }, { fullscreenWheelScrollLines: 0 },
    { fullscreenWheelScrollLines: 101 }, { fullscreenWheelScrollLines: 1.5 }, { autoCompact: false }, { transport: 'sse' }]) {
    expect(() => parseSchema(TuiPreferencesUpdateSchema, value)).toThrow();
  }
});
