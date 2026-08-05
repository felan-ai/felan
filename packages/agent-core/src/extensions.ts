import type {
  ExtensionAPI,
  InlineExtension,
} from '@earendil-works/pi-coding-agent';
import type { AgentRuntime } from './runtime.js';
import {
  associateCapabilityCollector,
  CapabilityCollector,
  type FelanCapability,
} from './capabilities.js';

export interface FelanExtensionAPI extends ExtensionAPI {
  readonly agentDir: string;
  readonly runtime: AgentRuntime;
  registerCapability(capability: FelanCapability): void;
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
  agentDir: string = runtime.cwd,
): InlineExtension {
  return bindFelanExtensionWithCapabilities(
    packageName,
    extension,
    runtime,
    agentDir,
    new CapabilityCollector(),
    true,
  );
}

function bindFelanExtensionWithCapabilities(
  packageName: string,
  extension: FelanExtension,
  runtime: AgentRuntime,
  agentDir: string,
  capabilityCollector: CapabilityCollector,
  resetCapabilities: boolean,
): InlineExtension {
  const inline: InlineExtension = {
    name: packageName,
    factory: async (pi) => {
      if (resetCapabilities) capabilityCollector.beginLoad();
      let initializing = true;
      const registerCapability = (capability: FelanCapability): void => {
        if (!initializing) {
          throw new Error(`Capability registration from ${packageName} is only available during initialization`);
        }
        capabilityCollector.register(packageName, capability);
      };
      try {
        await extension(createFelanExtensionAPI(
          pi,
          runtime,
          agentDir,
          registerCapability,
        ));
      } finally {
        initializing = false;
      }
    },
  };
  associateCapabilityCollector(inline, capabilityCollector);
  return inline;
}

export async function loadFelanExtensions(
  packageNames: readonly string[],
  importExtension: ExtensionPackageImporter,
  runtime: AgentRuntime,
  agentDir: string = runtime.cwd,
): Promise<InlineExtension[]> {
  const seen = new Set<string>();
  const extensions: InlineExtension[] = [];
  const capabilityCollector = new CapabilityCollector();

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

    extensions.push(bindFelanExtensionWithCapabilities(
      packageName,
      defaultExport as FelanExtension,
      runtime,
      agentDir,
      capabilityCollector,
      extensions.length === 0,
    ));
  }

  return extensions;
}

function createFelanExtensionAPI(
  pi: ExtensionAPI,
  runtime: AgentRuntime,
  agentDir: string,
  registerCapability: (capability: FelanCapability) => void,
): FelanExtensionAPI {
  const boundMethods = new Map<PropertyKey, unknown>();

  return new Proxy(pi as FelanExtensionAPI, {
    get(target, property) {
      if (property === 'agentDir') return agentDir;
      if (property === 'runtime') return runtime;
      if (property === 'registerCapability') {
        return registerCapability;
      }
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
      if (property === 'agentDir' || property === 'runtime' || property === 'registerCapability') return false;
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
