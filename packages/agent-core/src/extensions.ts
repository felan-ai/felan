import type {
  ExtensionAPI,
  InlineExtension,
} from '@earendil-works/pi-coding-agent';
import type { AgentRuntime } from './runtime.js';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { StreamFunction } from './session.js';
import type { TurnClassificationRegistry } from './classifier/turn-classification.js';
import type { ModelSelectionPersistenceScope, SessionSelectionAutomation } from './model-selection.js';
import type { SavingsReporter, SavingsReporterProvider } from './savings.js';
import { createUnavailableExtensionUi, type ExtensionUi, type ExtensionUiBindingFactory } from './extension-ui.js';
import { createExtensionConfigBinding, type ExtensionConfigWriter } from './extension-config-write.js';
import { createExtensionServiceAccess, createFelanServiceRegistry, type ExtensionServiceAccess, type ExtensionServiceRequirements, type FelanServiceRegistry } from './services.js';
import {
  associateCapabilityCollector,
  CapabilityCollector,
  type FelanCapability,
} from './capabilities.js';
import {
  type ExtensionConfigDefinition,
  type ExtensionConfigOverride,
  type ExtensionConfigValue,
  getExtensionConfigDefinition,
  resolveExtensionConfigs,
} from './extension-config.js';

export type { ExtensionConfigWriter } from './extension-config-write.js';

export interface FelanModelSelectionOptions {
  readonly updateDefault?: boolean;
}

export interface FelanExtensionAPI extends Omit<ExtensionAPI, 'getFlag' | 'registerFlag'> {
  readonly agentDir: string;
  readonly runtime: AgentRuntime;
  readonly config: Readonly<Record<string, ExtensionConfigValue>>;
  readonly savings?: SavingsReporter;
  readonly services: ExtensionServiceAccess;
  readonly ui: ExtensionUi;
  updateConfig(patch: Readonly<Record<string, ExtensionConfigValue>>): Promise<void>;
  readonly turnClassification?: TurnClassificationRegistry;
  readonly selectionAutomation?: SessionSelectionAutomation;
  registerCapability(capability: FelanCapability): void;
  setModel(
    model: Parameters<ExtensionAPI['setModel']>[0],
    options?: FelanModelSelectionOptions,
  ): ReturnType<ExtensionAPI['setModel']>;
  setThinkingLevel(
    level: Parameters<ExtensionAPI['setThinkingLevel']>[0],
    options?: FelanModelSelectionOptions,
  ): ReturnType<ExtensionAPI['setThinkingLevel']>;
}

export type FelanExtension = (
  pi: FelanExtensionAPI,
) => void | Promise<void>;

export interface ConfiguredFelanExtension extends FelanExtension {
  readonly configDefinition?: ExtensionConfigDefinition;
  readonly serviceRequirements?: ExtensionServiceRequirements;
  /** Resolved once per package load, after config validation and required-service admission. */
  readonly execution?: (context: FelanExecutionContext) => FelanExecutionContribution;
}

export interface FelanExecutionContext {
  readonly config: Readonly<Record<string, ExtensionConfigValue>>;
  readonly services: ExtensionServiceAccess;
}

export interface FelanExecutionContribution {
  /** Applied in package order, before the caller's wrapStreamFunction. */
  readonly wrapStreamFunction?: (original: StreamFunction) => StreamFunction;
  readonly supportsNativeThinkingUpdates?: (model: Model<Api>) => boolean;
}

const executionContributions = new WeakMap<object, {
  readonly contribution: FelanExecutionContribution;
  initialized: boolean;
}>();

export function getExecutionContribution(extension: InlineExtension): FelanExecutionContribution | undefined {
  const entry = executionContributions.get(extension);
  return entry?.initialized ? entry.contribution : undefined;
}

export type ExtensionPackageImporter = (
  packageName: string,
) => Promise<unknown>;

export function bindFelanExtension(
  packageName: string,
  extension: FelanExtension,
  runtime: AgentRuntime,
  agentDir: string = runtime.cwd,
  config: Readonly<Record<string, ExtensionConfigValue>> = {},
  savings?: SavingsReporterProvider,
  services: FelanServiceRegistry = createFelanServiceRegistry(),
  serviceRequirements: ExtensionServiceRequirements = {},
  createExtensionUi?: ExtensionUiBindingFactory,
  updateExtensionConfig?: ExtensionConfigWriter,
): InlineExtension {
  return bindFelanExtensionWithCapabilities(
    packageName,
    extension,
    runtime,
    agentDir,
    new CapabilityCollector(),
    true,
    undefined,
    config,
    savings,
    undefined,
    services,
    serviceRequirements,
    createExtensionUi,
    updateExtensionConfig,
  );
}

function bindFelanExtensionWithCapabilities(
  packageName: string,
  extension: FelanExtension,
  runtime: AgentRuntime,
  agentDir: string,
  capabilityCollector: CapabilityCollector,
  resetCapabilities: boolean,
  modelSelectionScope: ModelSelectionPersistenceScope | undefined,
  config: Readonly<Record<string, ExtensionConfigValue>>,
  savings: SavingsReporterProvider | undefined,
  turnClassification?: TurnClassificationRegistry,
  services: FelanServiceRegistry = createFelanServiceRegistry(),
  serviceRequirements: ExtensionServiceRequirements = {},
  createExtensionUi?: ExtensionUiBindingFactory,
  updateExtensionConfig?: ExtensionConfigWriter,
): InlineExtension {
  const createConfigBinding = createExtensionConfigBinding(packageName, getExtensionConfigDefinition(extension), updateExtensionConfig);
  const contribution = (extension as ConfiguredFelanExtension).execution?.({
    config,
    services: createExtensionServiceAccess(services, serviceRequirements),
  });
  const execution = contribution === undefined ? undefined : { contribution, initialized: false };
  const inline: InlineExtension = {
    name: packageName,
    factory: async (pi) => {
      const configBinding = createConfigBinding();
      if (execution) execution.initialized = false;
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
          modelSelectionScope,
          config,
          savings?.createReporter(packageName),
          turnClassification,
          services,
          serviceRequirements,
          createExtensionUi ? createExtensionUi(packageName) : createUnavailableExtensionUi(),
          configBinding.updateConfig,
        ));
        if (updateExtensionConfig) pi.on('session_shutdown', () => { configBinding.revoke(); });
        if (execution) execution.initialized = true;
      } catch (error) {
        configBinding.revoke();
        throw error;
      } finally {
        initializing = false;
      }
    },
  };
  if (execution) executionContributions.set(inline, execution);
  associateCapabilityCollector(inline, capabilityCollector);
  return inline;
}

export async function loadFelanExtensions(
  packageNames: readonly string[],
  importExtension: ExtensionPackageImporter,
  runtime: AgentRuntime,
  agentDir: string = runtime.cwd,
  configOverrides: readonly ExtensionConfigOverride[] = [],
  savings?: SavingsReporterProvider,
  services?: FelanServiceRegistry,
  onServiceRequirementFailure?: (packageName: string, service: string) => void,
  createExtensionUi?: ExtensionUiBindingFactory,
  updateExtensionConfig?: ExtensionConfigWriter,
): Promise<InlineExtension[]> {
  return loadFelanExtensionsWithScope(
    packageNames,
    importExtension,
    runtime,
    agentDir,
    undefined,
    configOverrides,
    savings,
    undefined,
    services,
    onServiceRequirementFailure,
    createExtensionUi,
    updateExtensionConfig,
  );
}

export async function loadFelanSessionExtensions(
  packageNames: readonly string[],
  importExtension: ExtensionPackageImporter,
  runtime: AgentRuntime,
  agentDir: string,
  modelSelectionScope: ModelSelectionPersistenceScope,
  configOverrides: readonly ExtensionConfigOverride[] = [],
  savings?: SavingsReporterProvider,
  turnClassification?: TurnClassificationRegistry,
  services?: FelanServiceRegistry,
  onServiceRequirementFailure?: (packageName: string, service: string) => void,
  createExtensionUi?: ExtensionUiBindingFactory,
  updateExtensionConfig?: ExtensionConfigWriter,
): Promise<InlineExtension[]> {
  return loadFelanExtensionsWithScope(
    packageNames,
    importExtension,
    runtime,
    agentDir,
    modelSelectionScope,
    configOverrides,
    savings,
    turnClassification,
    services,
    onServiceRequirementFailure,
    createExtensionUi,
    updateExtensionConfig,
  );
}

async function loadFelanExtensionsWithScope(
  packageNames: readonly string[],
  importExtension: ExtensionPackageImporter,
  runtime: AgentRuntime,
  agentDir: string,
  modelSelectionScope: ModelSelectionPersistenceScope | undefined,
  configOverrides: readonly ExtensionConfigOverride[],
  savings: SavingsReporterProvider | undefined,
  turnClassification?: TurnClassificationRegistry,
  services?: FelanServiceRegistry,
  onServiceRequirementFailure?: (packageName: string, service: string) => void,
  createExtensionUi?: ExtensionUiBindingFactory,
  updateExtensionConfig?: ExtensionConfigWriter,
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

    const configuredExtension = defaultExport as ConfiguredFelanExtension;
    const serviceRequirements = configuredExtension.serviceRequirements ?? {};
    const missing = (serviceRequirements.required ?? []).find(contract => services?.get(contract) === undefined);
    if (missing) {
      onServiceRequirementFailure?.(packageName, missing.key);
      continue;
    }
    const definition = getExtensionConfigDefinition(configuredExtension);
    const config = definition === undefined
      ? {}
      : resolveExtensionConfigs([definition], configOverrides.filter(({ extensionId }) => extensionId === definition.id)).get(definition.id)!;
    extensions.push(bindFelanExtensionWithCapabilities(
      packageName,
      defaultExport as FelanExtension,
      runtime,
      agentDir,
      capabilityCollector,
      extensions.length === 0,
      modelSelectionScope,
      config,
      savings,
      turnClassification,
      services,
      serviceRequirements,
      createExtensionUi,
      updateExtensionConfig,
    ));
  }

  return extensions;
}

function createFelanExtensionAPI(
  pi: ExtensionAPI,
  runtime: AgentRuntime,
  agentDir: string,
  registerCapability: (capability: FelanCapability) => void,
  modelSelectionScope: ModelSelectionPersistenceScope | undefined,
  config: Readonly<Record<string, ExtensionConfigValue>>,
  savings: SavingsReporter | undefined,
  turnClassification?: TurnClassificationRegistry,
  services: FelanServiceRegistry = createFelanServiceRegistry(),
  serviceRequirements: ExtensionServiceRequirements = {},
  ui: ExtensionUi = createUnavailableExtensionUi(),
  updateConfig: FelanExtensionAPI['updateConfig'] = async () => { throw new Error('Extension configuration persistence is unsupported.'); },
): FelanExtensionAPI {
  const boundMethods = new Map<PropertyKey, unknown>();

  return new Proxy(pi as unknown as FelanExtensionAPI, {
    get(target, property) {
      if (property === 'agentDir') return agentDir;
      if (property === 'runtime') return runtime;
      if (property === 'config') return config;
      if (property === 'updateConfig') return updateConfig;
      if (property === 'savings') return savings;
      if (property === 'turnClassification') return turnClassification;
      if (property === 'services') return createExtensionServiceAccess(services, serviceRequirements);
      if (property === 'ui') return ui;
      if (property === 'selectionAutomation') return modelSelectionScope;
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
      if (property === 'setModel') {
        if (!boundMethods.has(property)) {
          const setModel = target.setModel.bind(target);
          boundMethods.set(property, (
            model: Parameters<ExtensionAPI['setModel']>[0],
            options?: FelanModelSelectionOptions,
          ) => {
            const updateDefault = options?.updateDefault !== false;
            if (!modelSelectionScope) {
              if (!updateDefault) {
                return Promise.reject(new Error(
                  'Session-only model selection requires Agent Core session composition',
                ));
              }
              return setModel(model);
            }
            return modelSelectionScope.run(updateDefault, () => setModel(model));
          });
        }
        return boundMethods.get(property);
      }
      if (property === 'setThinkingLevel') {
        if (!boundMethods.has(property)) {
          const setThinkingLevel = target.setThinkingLevel.bind(target);
          boundMethods.set(property, (
            level: Parameters<ExtensionAPI['setThinkingLevel']>[0],
            options?: FelanModelSelectionOptions,
          ) => {
            const updateDefault = options?.updateDefault !== false;
            if (!modelSelectionScope) {
              if (!updateDefault) {
                throw new Error(
                  'Session-only thinking selection requires Agent Core session composition',
                );
              }
              return setThinkingLevel(level);
            }
            return modelSelectionScope.run(updateDefault, () => setThinkingLevel(level));
          });
        }
        return boundMethods.get(property);
      }

      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;

      if (!boundMethods.has(property)) {
        boundMethods.set(property, value.bind(target));
      }
      return boundMethods.get(property);
    },
    set(target, property, value) {
      if (
        property === 'agentDir'
        || property === 'runtime'
        || property === 'config'
        || property === 'updateConfig'
        || property === 'savings'
        || property === 'turnClassification'
        || property === 'services'
        || property === 'ui'
        || property === 'selectionAutomation'
        || property === 'registerCapability'
      ) return false;
      return Reflect.set(target, property, value, target);
    },
    has(target, property) {
      return property === 'ui' || property === 'updateConfig' || Reflect.has(target, property);
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
