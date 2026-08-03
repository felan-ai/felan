import type { ExtensionPackageImporter } from '@felan-ai/agent-core';

export const localExtensionPackages = [
  '@felan-ai/ext-prewalk',
  '@felan-ai/ext-context',
  '@felan-ai/ext-powerline',
] as const;

const localExtensionImporters: Record<string, () => Promise<unknown>> = {
  '@felan-ai/ext-prewalk': () => import('@felan-ai/ext-prewalk'),
  '@felan-ai/ext-context': () => import('@felan-ai/ext-context'),
  '@felan-ai/ext-powerline': () => import('@felan-ai/ext-powerline'),
};

export const importLocalExtension: ExtensionPackageImporter = async (packageName) => {
  const importExtension = localExtensionImporters[packageName];
  if (!importExtension) {
    throw new Error(`Unknown local extension package: ${packageName}`);
  }
  return importExtension();
};
