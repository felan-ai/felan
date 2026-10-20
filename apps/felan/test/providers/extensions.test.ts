import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { HostAgentRuntime, createFelanServiceRegistry, loadFelanExtensions } from '@felan-ai/agent-core';
import { builtinExtensionPackages, importLocalExtension, resolveConfiguredExtensionPackages } from '../../src/providers/extensions.js';

const installed: string[] = [];
afterEach(async () => { await Promise.all(installed.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function installFixture(source: string) {
  const name = `felan-extension-fixture-${randomUUID()}`;
  const directory = fileURLToPath(new URL(`../../node_modules/${name}/`, import.meta.url));
  await mkdir(directory, { recursive: true }); installed.push(directory);
  await writeFile(`${directory}/package.json`, JSON.stringify({ name, type: 'module', exports: './index.js' }));
  await writeFile(`${directory}/index.js`, source);
  return name;
}

async function runtime() {
  const directory = await mkdtemp(join(tmpdir(), 'felan-extension-loader-')); installed.push(directory);
  return new HostAgentRuntime(directory, { sessionStorageRoot: directory, agentStorageRoot: directory });
}

it('preserves the supplied host extension order', () => {
  const packages = ['third-party-second', 'third-party-first', builtinExtensionPackages.tasks];
  expect(resolveConfiguredExtensionPackages(packages, undefined)).toEqual(packages);
});

it('loads an installed extension named only in host configuration', async () => {
  const name = await installFixture('export default () => {};');
  const packages = resolveConfiguredExtensionPackages([name, builtinExtensionPackages.askUser], { askUser: false });
  expect(packages).toEqual([name]);
  const loaded = await loadFelanExtensions(packages, importLocalExtension, await runtime());
  expect(loaded).toHaveLength(1);
  expect(loaded[0]).toMatchObject({ name });
});

it('skips and reports an installed extension missing its required contract', async () => {
  const name = await installFixture(`export default Object.assign(() => {}, {
    serviceRequirements: { required: [{ id: 'fixture.required', major: 3, key: 'fixture.required@3' }] }
  });`);
  const skipped: Array<[string, string]> = [];
  const loaded = await loadFelanExtensions([name], importLocalExtension, await runtime(), undefined,
    [], undefined, createFelanServiceRegistry(), (packageName, contract) => skipped.push([packageName, contract]));
  expect(loaded).toEqual([]);
  expect(skipped).toEqual([[name, 'fixture.required@3']]);
});

it('preserves the host list and only applies user disable toggles', () => {
  expect(resolveConfiguredExtensionPackages(['third-party-extension', builtinExtensionPackages.tasks], { tasks: true }))
    .toEqual(['third-party-extension', builtinExtensionPackages.tasks]);
  expect(resolveConfiguredExtensionPackages(['third-party-extension', builtinExtensionPackages.tasks], { tasks: false }))
    .toEqual(['third-party-extension']);
  expect(() => resolveConfiguredExtensionPackages(['a', 'a'], {})).toThrow('duplicate extensions');
  expect(() => resolveConfiguredExtensionPackages([], { unknown: true })).toThrow('Unknown built-in extension');
  expect(() => resolveConfiguredExtensionPackages([], { tasks: 'yes' })).toThrow('must be a boolean');
});
