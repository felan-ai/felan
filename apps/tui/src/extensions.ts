import type { ExtensionPackageImporter } from '@felan-ai/agent-core';

export const localExtensionPackages = [
  '@felan-ai/ext-prewalk',
  '@felan-ai/ext-context',
  '@felan-ai/ext-powerline',
] as const;

const localExtensionPackageSet: ReadonlySet<string> = new Set(localExtensionPackages);

export const importLocalExtension: ExtensionPackageImporter = async (packageName) => {
  if (!localExtensionPackageSet.has(packageName)) {
    throw new Error(`Unknown local extension package: ${packageName}`);
  }
  return import(packageName);
};
