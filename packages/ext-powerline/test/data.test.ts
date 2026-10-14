import { expect, it } from 'vitest';
import { parsePowerlineData } from '../src/data.js';

it('validates structured values without accepting client display policy or terminal controls', () => {
  const segment = { name: 'directory', colorKey: 'directory', values: { cwd: '/workspace' } };
  expect(parsePowerlineData({ segments: [segment] })).toEqual({ segments: [segment] });
  for (const value of [
    { segments: [segment], style: 'capsule' },
    { segments: [{ ...segment, values: { cwd: '\x1b]2;injected\x07' } }] },
    { segments: [{ ...segment, colorKey: '__proto__' }] },
    { segments: [segment, segment] },
    { segments: [{ ...segment, values: { cwd: 'x'.repeat(8192) } }] },
    { segments: [{ name: 'session', colorKey: 'session', values: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }] },
    { segments: [{ ...segment, values: { cwd: '/workspace', padding: 1 } }] },
  ]) expect(() => parsePowerlineData(value)).toThrow();
});
