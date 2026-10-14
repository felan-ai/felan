import {
  getExtensionConfigDefinition,
  type ExtensionConfigDefinition,
  type ExtensionPackageImporter,
} from '@felan-ai/agent-core';

import {
  builtinExtensionPackages,
  validateBuiltinExtensionKeys,
  type BuiltinExtensionName,
} from './extension-catalog.js';
export * from './extension-catalog.js';

export function resolveConfiguredExtensionPackages(allowlist: readonly string[], settings: unknown): readonly string[] {
  validateBuiltinExtensionKeys(settings);
  if (new Set(allowlist).size !== allowlist.length) throw new Error('host.json contains duplicate extensions');
  const disabled = new Set<string>(Object.entries(builtinExtensionPackages)
    .filter(([name]) => settings?.[name as BuiltinExtensionName] === false)
    .map(([, packageName]) => packageName));
  return allowlist.filter(packageName => !disabled.has(packageName));
}

export const importLocalExtension: ExtensionPackageImporter = packageName => import(import.meta.resolve(packageName));

export async function loadLocalExtensionConfigDefinitions(
  packages: readonly string[],
  importExtension: ExtensionPackageImporter = importLocalExtension,
): Promise<readonly ExtensionConfigDefinition[]> {
  return [...(await loadLocalExtensionConfigDefinitionsByPackage(packages, importExtension)).values()];
}

export async function loadLocalExtensionConfigDefinitionsByPackage(
  packages: readonly string[],
  importExtension: ExtensionPackageImporter = importLocalExtension,
): Promise<ReadonlyMap<string, ExtensionConfigDefinition>> {
  const definitions = new Map<string, ExtensionConfigDefinition>();
  for (const packageName of packages) {
    const imported = await importExtension(packageName);
    const extension = (typeof imported === 'object' && imported !== null)
      ? Reflect.get(imported, 'default')
      : undefined;
    if (typeof extension !== 'function') continue;
    const definition = getExtensionConfigDefinition(extension);
    if (definition) definitions.set(packageName, definition);
  }
  return definitions;
}

