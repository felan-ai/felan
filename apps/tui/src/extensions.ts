import type { ExtensionPackageImporter, ModelRuntime } from '@felan-ai/agent-core';
import { createAskUserExtension } from '@felan-ai/ext-ask-user';
import { createTuiAskUserHost } from '@felan-ai/ext-ask-user/tui';
import { createMemoryExtension, type MemoryHost, type MemoryRole } from '@felan-ai/ext-memory';
import { createPowerlineExtension } from '@felan-ai/ext-powerline';
import {
  createSubagentsExtension,
  type SubagentHost,
} from '@felan-ai/ext-subagents';
import { createLocalMcpExtension } from './mcp/index.js';
import { createLocalSubscriptionUsageHost } from './powerline.js';
import {
  registerLocalSubagentNavigator,
  type AgentRailRenderer,
  type LocalSubagentNavigatorHost,
} from './subagents/agent-navigator.js';

export const askUserExtensionPackage = '@felan-ai/ext-ask-user';
export const mcpExtensionPackage = '@felan-ai/ext-mcp';
export const powerlineExtensionPackage = '@felan-ai/ext-powerline';
export const subagentsExtensionPackage = '@felan-ai/ext-subagents';
export const memoryExtensionPackage = '@felan-ai/ext-memory';
export const builtinExtensionPackages = {
  subagents: subagentsExtensionPackage,
  askUser: askUserExtensionPackage,
  tasks: '@felan-ai/ext-tasks',
  prewalk: '@felan-ai/ext-prewalk',
  mcp: mcpExtensionPackage,
  webAccess: '@felan-ai/ext-web-access',
  backgroundBash: '@felan-ai/ext-background-bash',
  codex: '@felan-ai/ext-codex',
  rtkOptimizer: '@felan-ai/ext-rtk-optimizer',
  // Append conversion diagnostics after result optimization, then restore the source path for progressive context.
  markitdown: '@felan-ai/ext-markitdown',
  context: '@felan-ai/ext-context',
  memory: memoryExtensionPackage,
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

export interface LocalMemoryExtensionBinding {
  readonly role: MemoryRole;
  readonly host: MemoryHost;
}

export function createLocalExtensionImporter(
  host: SubagentHost & LocalSubagentNavigatorHost,
  modelRuntime: ModelRuntime,
  importExtension: ExtensionPackageImporter = importLocalExtension,
  shutdownHost?: () => Promise<void>,
  memoryBinding?: LocalMemoryExtensionBinding,
): ExtensionPackageImporter {
  let powerlineLoaded = false;
  let agentRailRenderer: AgentRailRenderer | undefined;
  const powerline = createPowerlineExtension(createLocalSubscriptionUsageHost(modelRuntime), {
    footerRows: (width) => agentRailRenderer?.(width) ?? [],
  });
  return async (packageName) => {
    if (packageName === askUserExtensionPackage) {
      return { default: createAskUserExtension(createTuiAskUserHost()) };
    }
    if (packageName === mcpExtensionPackage) {
      return { default: createLocalMcpExtension() };
    }
    if (packageName === subagentsExtensionPackage) {
      const subagents = createSubagentsExtension(host);
      return {
        default: ((pi) => {
          subagents(pi);
          registerLocalSubagentNavigator(pi, host, {
            renderRailInEditor: () => !powerlineLoaded,
            onRailRendererChange: (renderer) => {
              agentRailRenderer = renderer;
            },
          });
          if (shutdownHost) {
            pi.on('session_shutdown', async (event) => {
              if (event.reason !== 'reload') await shutdownHost();
            });
          }
        }) satisfies ReturnType<typeof createSubagentsExtension>,
      };
    }
    if (packageName === powerlineExtensionPackage) {
      powerlineLoaded = true;
      return { default: powerline };
    }
    if (packageName === memoryExtensionPackage) {
      if (!memoryBinding) throw new Error('Local memory extension requires a host binding');
      return { default: createMemoryExtension(memoryBinding) };
    }
    return importExtension(packageName);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
