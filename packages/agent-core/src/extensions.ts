import type {
  ExtensionAPI,
  InlineExtension,
} from '@earendil-works/pi-coding-agent';
import type { AgentRuntime } from './runtime.js';

export interface FelanExtensionAPI extends ExtensionAPI {
  readonly runtime: AgentRuntime;
}

export type FelanExtension = (
  pi: FelanExtensionAPI,
) => void | Promise<void>;

export type ExtensionPackageImporter = (
  packageName: string,
) => Promise<unknown>;

export function bindFelanExtension(
  packageName: string,
  extension: FelanExtension,
  runtime: AgentRuntime,
): InlineExtension {
  return {
    name: packageName,
    factory: (pi) => extension(createFelanExtensionAPI(pi, runtime)),
  };
}

export async function loadFelanExtensions(
  packageNames: readonly string[],
  importExtension: ExtensionPackageImporter,
  runtime: AgentRuntime,
): Promise<InlineExtension[]> {
  const seen = new Set<string>();
  const extensions: InlineExtension[] = [];

  for (const packageName of packageNames) {
    if (seen.has(packageName)) {
      throw new Error(`Duplicate Felan extension package: ${packageName}`);
    }
    seen.add(packageName);

    let imported: unknown;
    try {
      imported = await importExtension(packageName);
    } catch (error) {
      throw new Error(`Failed to import Felan extension ${packageName}: ${errorMessage(error)}`, {
        cause: error,
      });
    }

    let defaultExport: unknown;
    try {
      defaultExport = getDefaultExport(imported);
    } catch (error) {
      throw new Error(`Failed to inspect Felan extension ${packageName}: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    if (typeof defaultExport !== 'function') {
      throw new Error(`${packageName} must default-export a Felan extension`);
    }

    extensions.push(bindFelanExtension(
      packageName,
      defaultExport as FelanExtension,
      runtime,
    ));
  }

  return extensions;
}

function createFelanExtensionAPI(
  pi: ExtensionAPI,
  runtime: AgentRuntime,
): FelanExtensionAPI {
  const boundMethods = new Map<PropertyKey, unknown>();

  return new Proxy(pi as FelanExtensionAPI, {
    get(target, property) {
      if (property === 'runtime') return runtime;
      if (property === 'exec') {
        return (
          command: string,
          args: string[],
          options?: Parameters<AgentRuntime['exec']>[2],
        ) => runtime.exec(command, args, options);
      }

      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;

      if (!boundMethods.has(property)) {
        boundMethods.set(property, value.bind(target));
      }
      return boundMethods.get(property);
    },
    set(target, property, value) {
      if (property === 'runtime') return false;
      return Reflect.set(target, property, value, target);
    },
  });
}

function getDefaultExport(imported: unknown): unknown {
  if ((typeof imported !== 'object' || imported === null) && typeof imported !== 'function') {
    return undefined;
  }
  return Reflect.get(imported, 'default');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
