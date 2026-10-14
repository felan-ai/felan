import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { getExtensionConfigCliOptions } from '@felan-ai/agent-core';
import { ConfigValuesSchema } from '@felan-ai/session-protocol';
import { DaemonConfiguration } from '../../src/providers/configuration.js';
import { builtinExtensionPackages, resolveConfiguredExtensionPackages } from '../../src/providers/extensions.js';
import { loadLocalExtensionConfigDefinitions } from '../../src/providers/extensions.js';
import { createLocalSettingsManager, getClassifierModelSetting, getFelanSettings, setExtensionConfigValues } from '../../src/providers/settings.js';

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'provider-config-')); paths.push(root);
  const agentDir = join(root, 'agent'); await mkdir(agentDir); await writeFile(join(agentDir, 'settings.json'), '{}', { mode: 0o600 });
  return realpath(agentDir);
}

async function configuredDefinitions() {
  const host = JSON.parse(await readFile(new URL('../../src/host.json', import.meta.url), 'utf8')) as { extensions: Array<{ package: string }> };
  return loadLocalExtensionConfigDefinitions(host.extensions.map(extension => extension.package));
}

it('lets host.json narrow builtinExtensions settings but never lets settings widen the allowlist', () => {
  expect(resolveConfiguredExtensionPackages([builtinExtensionPackages.subagents], { subagents: true, tasks: true })).toEqual([builtinExtensionPackages.subagents]);
  expect(resolveConfiguredExtensionPackages([], { subagents: true })).toEqual([]);
  expect(resolveConfiguredExtensionPackages([builtinExtensionPackages.subagents], { subagents: false })).toEqual([]);
});

it('maps the exact existing 64 noncredential fields from built-in definitions', async () => {
  const agentDir = await fixture(); const definitions = await configuredDefinitions();
  const globalFields = ['scopedModels', 'defaultModel', 'defaultThinking', 'classifierModel', 'builtinExtensions', 'extensionConfig', 'codemode',
    'imageAutoResize', 'blockImages', 'autoCompact', 'skillCommands', 'steeringMode', 'followUpMode', 'transport', 'httpIdleTimeoutMs', 'cacheWarming', 'modelThinkingLevels'];
  const expected = Object.keys(ConfigValuesSchema.properties).filter(key => !globalFields.includes(key));
  const fields = getExtensionConfigCliOptions(definitions).filter(field => expected.includes(field.name));
  expect(new Set(fields.map(field => field.name))).toEqual(new Set(expected)); expect(fields).toHaveLength(64);
  const result = await new DaemonConfiguration({ agentDir, definitions, assertCurrent() {} }).get('global');
  expect(Object.keys(result.values).every(key => expected.includes(key) || globalFields.includes(key))).toBe(true);
  expect(result.values.builtinExtensions).toEqual(Object.fromEntries(Object.keys(builtinExtensionPackages).map(name => [name, true])));
  expect(result.values.codemode).toBe('on');
  expect(result.extensions?.map(extension => ({ id: extension.id, fields: extension.fields.map(field => field.id) }))).toEqual(
    definitions.map(definition => ({ id: definition.id, fields: Object.entries(definition.fields).filter(([, field]) => !field.deprecated).map(([id]) => id) }))
      .filter(extension => extension.fields.length),
  );
  for (const field of fields) {
    expect(result.values.extensionConfig?.[field.extensionId]?.[field.field], field.name).toEqual(
      field.configField.deprecated ? undefined : result.values[field.name as keyof typeof result.values],
    );
  }
});

it('applies execution defaults to fresh provider settings without mutating existing settings or widening host.json', async () => {
  const agentDir = await fixture(); const existing = createLocalSettingsManager(agentDir, agentDir);
  const config = new DaemonConfiguration({ agentDir, definitions: [], assertCurrent() {} });
  await config.set('global', { classifierModel: 'offline/classifier', builtinExtensions: { memory: false, tasks: true } });
  const resolved = await config.get('global');
  expect(resolved.values.builtinExtensions).toEqual({
    ...Object.fromEntries(Object.keys(builtinExtensionPackages).map(name => [name, true])), memory: false,
  });
  const next = createLocalSettingsManager(agentDir, agentDir);
  expect(getClassifierModelSetting(existing)).toBe('auto');
  expect(getClassifierModelSetting(next)).toBe('offline/classifier');
  expect(resolveConfiguredExtensionPackages([builtinExtensionPackages.memory], getFelanSettings(next).builtinExtensions)).toEqual([]);
  await config.set('global', { builtinExtensions: { memory: true } });
  const reloaded = createLocalSettingsManager(agentDir, agentDir);
  expect(resolveConfiguredExtensionPackages([builtinExtensionPackages.memory], getFelanSettings(reloaded).builtinExtensions)).toEqual([builtinExtensionPackages.memory]);
});

it('preserves the legacy local settings writer through provider extraction', async () => {
  const agentDir = await fixture(); await setExtensionConfigValues(agentDir, 'codex', { fast: true });
  const definitions = await configuredDefinitions();
  expect(await new DaemonConfiguration({ agentDir, definitions, assertCurrent() {} }).get('global'))
    .toMatchObject({ values: { 'codex-fast': true } });
});

it('rejects unknown built-in names before persisting any configuration fields', async () => {
  const agentDir = await fixture(); const path = join(agentDir, 'settings.json');
  const config = new DaemonConfiguration({ agentDir, definitions: [], assertCurrent() {} });
  const values = { classifierModel: 'auto', builtinExtensions: { unknownBuiltin: false } };
  expect(() => config.prepare('global', values)).toThrow('Unknown built-in extension: unknownBuiltin');
  await expect(config.set('global', values)).rejects.toThrow('Unknown built-in extension: unknownBuiltin');
  expect(await readFile(path, 'utf8')).toBe('{}');
});

it('uses the same normalized classifier reference for writes and reads', async () => {
  const agentDir = await fixture(); const config = new DaemonConfiguration({ agentDir, definitions: [], assertCurrent() {} });
  await config.set('global', { classifierModel: ' openrouter/ typesafe/jev-1.13 ' });
  expect((await config.get('global')).values.classifierModel).toBe('openrouter/typesafe/jev-1.13');
  expect(getClassifierModelSetting(createLocalSettingsManager(agentDir, agentDir))).toBe('openrouter/typesafe/jev-1.13');
});
