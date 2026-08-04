import type { ExtensionPackageImporter } from '@felan-ai/agent-core';
import {
  createSubagentsExtension,
  type SubagentHost,
} from '@felan-ai/ext-subagents';

export const subagentsExtensionPackage = '@felan-ai/ext-subagents';
export const localExtensionPackages = [
  '@felan-ai/ext-subagents',
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

export function createLocalExtensionImporter(
  host: SubagentHost,
  importExtension: ExtensionPackageImporter = importLocalExtension,
  shutdownHost?: () => Promise<void>,
): ExtensionPackageImporter {
  return async (packageName) => {
    if (packageName === subagentsExtensionPackage) {
      const subagents = createSubagentsExtension(host);
      return {
        default: ((pi) => {
          subagents(pi);
          if (shutdownHost) {
            pi.on('session_shutdown', async (event) => {
              if (event.reason !== 'reload') await shutdownHost();
            });
          }
        }) satisfies ReturnType<typeof createSubagentsExtension>,
      };
    }
    return importExtension(packageName);
  };
}
