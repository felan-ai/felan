import { expect, it } from 'vitest';
import { ConfigValuesSchema, parseSchema } from '../src/index.js';

it('validates execution defaults without accepting client rendering preferences', () => {
  const defaults = { autoCompact: false, skillCommands: false, steeringMode: 'all', followUpMode: 'one-at-a-time', transport: 'websocket-cached',
    cacheWarming: 'idle', httpIdleTimeoutMs: 0, modelThinkingLevels: { 'offline/model': 'max' } };
  expect(parseSchema(ConfigValuesSchema, defaults)).toEqual(defaults);
  for (const value of [{ autoCompact: 'false' }, { steeringMode: 'none' }, { transport: 'ftp' }, { cacheWarming: 'always' },
    { httpIdleTimeoutMs: -1 }, { httpIdleTimeoutMs: 1.5 }, { httpIdleTimeoutMs: 2147483648 }, { modelThinkingLevels: { 'p/m': 'unlimited' } }, { mermaid: 'off' }]) {
    expect(() => parseSchema(ConfigValuesSchema, value)).toThrow();
  }
});
