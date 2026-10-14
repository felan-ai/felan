import { expect, it } from 'vitest';
import { cliConfigOptions, parseCliConfigValue } from '../src/cli-config.js';

it('generates execution flags from built-in definitions and keeps presentation local', async () => {
  const options = await cliConfigOptions();
  const option = (name: string) => options.find(option => option.name === name)!;
  expect(parseCliConfigValue(option('codex-priority'), 'ultrafast')).toBe('ultrafast');
  expect(parseCliConfigValue(option('codex-fast'), true)).toBe(true);
  expect(parseCliConfigValue(option('fusion-participants'), '["openai/model-a","anthropic/model-b"]')).toEqual(['openai/model-a', 'anthropic/model-b']);
  expect(() => parseCliConfigValue(option('codex-priority'), 'invalid')).toThrow();
  expect(option('powerline-style').presentation).toBe(true);
  expect(() => parseCliConfigValue(option('powerline-padding'), '4097')).toThrow();
  expect(() => parseCliConfigValue(option('powerline-lines'), '[{"segments":{"unknown":{}}}]')).toThrow();
  expect(() => parseCliConfigValue(option('ask-user-overlay-toggle-key'), 'alt++o')).toThrow();
  expect(option('powerline-show-working-tree').presentation).toBeUndefined();
  expect(options.some(option => option.name === 'extension-config')).toBe(false);
  expect(new Set(options.map(option => option.name)).size).toBe(options.length);
});

it('keeps local presentation metadata out of execution definitions', async () => {
  const options = await cliConfigOptions();
  const local = options.filter(option => option.presentation).map(option => option.name);
  expect(local).toEqual(expect.arrayContaining(['ask-user-display-mode', 'tasks-display-mode', 'prompt-history-display-mode', 'context-view-display-mode', 'powerline-lines']));
  const context = options.find(option => option.name === 'context-view-display-mode')!;
  expect(context.presentation).toBe(true);
  expect(context.configField.description).toBe('Render context usage inline or in a centered overlay');
  expect(parseCliConfigValue(context, 'overlay')).toBe('overlay');
  expect(() => parseCliConfigValue(context, 'other')).toThrow();
  expect(options.filter(option => !option.presentation).some(option => ['askUser', 'tasks', 'promptHistory'].includes(option.extensionId))).toBe(false);
});
