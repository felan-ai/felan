import type { ExtensionPackageImporter, ModelRuntime } from '@felan-ai/agent-core';
import { createAskUserExtension } from '@felan-ai/ext-ask-user';
import { createTuiAskUserHost } from '@felan-ai/ext-ask-user/tui';
import { createPowerlineExtension } from '@felan-ai/ext-powerline';
import {
  createSubagentsExtension,
  type SubagentHost,
} from '@felan-ai/ext-subagents';
import { createLocalSubscriptionUsageHost } from './powerline.js';

export const askUserExtensionPackage = '@felan-ai/ext-ask-user';
export const powerlineExtensionPackage = '@felan-ai/ext-powerline';
export const subagentsExtensionPackage = '@felan-ai/ext-subagents';
export const builtinExtensionPackages = {
  subagents: subagentsExtensionPackage,
  askUser: askUserExtensionPackage,
  tasks: '@felan-ai/ext-tasks',
  prewalk: '@felan-ai/ext-prewalk',
  context: '@felan-ai/ext-context',
  webAccess: '@felan-ai/ext-web-access',
  backgroundBash: '@felan-ai/ext-background-bash',
  codex: '@felan-ai/ext-codex',
  powerline: powerlineExtensionPackage,
} as const;
export const localExtensionPackages = Object.values(builtinExtensionPackages);

export type BuiltinExtensionName = keyof typeof builtinExtensionPackages;
export type BuiltinExtensionSettings = Partial<Record<BuiltinExtensionName, boolean>>;

const localExtensionPackageSet: ReadonlySet<string> = new Set(localExtensionPackages);

export function resolveBuiltinExtensionPackages(settings: unknown): readonly string[] {
  if (settings === undefined) return localExtensionPackages;
  if (!isRecord(settings)) throw new Error('builtinExtensions must be an object');

  for (const [name, enabled] of Object.entries(settings)) {
    if (!Object.hasOwn(builtinExtensionPackages, name)) throw new Error(`Unknown built-in extension: ${name}`);
    if (typeof enabled !== 'boolean') throw new Error(`Built-in extension ${name} must be a boolean`);
  }

  return Object.entries(builtinExtensionPackages)
    .filter(([name]) => settings[name] !== false)
    .map(([, packageName]) => packageName);
}

export const importLocalExtension: ExtensionPackageImporter = async (packageName) => {
  if (!localExtensionPackageSet.has(packageName)) {
    throw new Error(`Unknown local extension package: ${packageName}`);
  }
  return import(packageName);
};

export function createLocalExtensionImporter(
  host: SubagentHost,
  modelRuntime: ModelRuntime,
  importExtension: ExtensionPackageImporter = importLocalExtension,
  shutdownHost?: () => Promise<void>,
): ExtensionPackageImporter {
  const powerline = createPowerlineExtension(createLocalSubscriptionUsageHost(modelRuntime));
  return async (packageName) => {
    if (packageName === askUserExtensionPackage) {
      return { default: createAskUserExtension(createTuiAskUserHost()) };
    }
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
    if (packageName === powerlineExtensionPackage) {
      return { default: powerline };
    }
    return importExtension(packageName);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
