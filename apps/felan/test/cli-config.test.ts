import { expect, it } from 'vitest';
import { cliConfigOptions, parseCliConfigValue } from '../src/cli-config.js';

it('validates enum, boolean, numeric and structured command-line values at the protocol boundary', () => {
  const option = (name: string) => cliConfigOptions.find(value => value.name === name)!;
  expect(parseCliConfigValue(option('prewalk-entry-approval'), 'allow')).toBe('allow');
  expect(parseCliConfigValue(option('codex-fast'), true)).toBe(true);
  expect(parseCliConfigValue(option('fusion-concurrency'), '3')).toBe(3);
  expect(parseCliConfigValue(option('powerline-lines'), '[{"segments":{"status":{"enabled":true}}}]'))
    .toEqual([{ segments: { status: { enabled: true } } }]);
  expect(() => parseCliConfigValue(option('prewalk-entry-approval'), 'invalid')).toThrow();
  expect(() => parseCliConfigValue(option('fusion-concurrency'), 'not-a-number')).toThrow();
});

it('does not advertise host model-scope fields as extension flags', () => {
  expect(cliConfigOptions.some(option => ['scopedModels', 'defaultModel', 'defaultThinking'].includes(option.name))).toBe(false);
});
