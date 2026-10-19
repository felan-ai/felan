import { defineServiceContract, type AgentRuntime, type AgentSessionRuntimeDiagnostic, type CreateAgentCoreSessionOptions, type ExtensionConfigDefinition, type ExtensionConfigOverride, type ExtensionConfigValue, type Logger, type ModelRuntime, type SessionEntry, type SessionRef } from '@felan-ai/agent-core';
import type { Interaction, Message } from '@felan-ai/session-protocol';
import type { HostServices, HostServicesRequest } from './host-services.js';
import type { ProviderSecretStorage } from './provider.js';
import type { ProcessAdapter } from './process-adapter.js';
import type { SessionExecutionPort, SessionExtensionBindings, SessionExtensionContext } from './session-execution.js';
export type { SetupDependency } from '../setup/dependencies.js';
export type { HostConfiguration, HostSetup, HostServices, HostServicesRequest } from './host-services.js';

export interface SessionEnvironment {
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly sessionStorageBase: string;
  readonly agentStorageRoot: string;
  readonly writableRoots: readonly string[];
  readonly workerRoots?: readonly string[];
}

export interface SessionEnvironmentRequest {
  readonly cwd: string;
  readonly agentDir: string;
  readonly homeDir?: string;
  readonly sessionDir?: string;
}

export interface SessionCompositionRequest {
  readonly environment: SessionEnvironment;
  readonly session: SessionRef;
  readonly modelRuntime: ModelRuntime;
  readonly logger?: Logger;
  readonly homeDir?: string;
  readonly extensionPackages: readonly string[];
  readonly extensionConfigOverrides: readonly ExtensionConfigOverride[];
  readonly extensionPaths: readonly string[];
  readonly model?: CreateAgentCoreSessionOptions['model'];
  readonly thinkingLevel?: CreateAgentCoreSessionOptions['thinkingLevel'];
}

export type SessionCompositionOptions = Pick<CreateAgentCoreSessionOptions,
  'runtime' | 'modelRuntime' | 'settingsManager' | 'extensionPackages' | 'importExtension'
  | 'extensionPaths' | 'extensionConfigOverrides' | 'model' | 'thinkingLevel' | 'dynamicThinking'
  | 'scopedModels' | 'inlineExtensions' | 'customTools' | 'skillPaths' | 'themePaths' | 'skills' | 'appendSystemPrompt'>;

export interface SessionToolPolicy {
  readonly trustedInlinePaths: readonly string[];
  readonly approvalExemptTools: readonly string[];
}

export interface SessionComposition {
  readonly options: SessionCompositionOptions;
  readonly toolPolicy?: SessionToolPolicy;
  readonly extensionConfigs: ReadonlyMap<string, Readonly<Record<string, ExtensionConfigValue>>>;
  readonly diagnostics: readonly AgentSessionRuntimeDiagnostic[];
  dispose(): Promise<void>;
}

export interface SessionRuntime {
  readonly toolPolicy?: SessionToolPolicy;
  createModelRuntime(agentDir: string): Promise<ModelRuntime>;
  readonly secretStorage: ProviderSecretStorage;
  createHostServices(request: HostServicesRequest): Promise<HostServices>;
  readonly processAdapter?: ProcessAdapter;
  projectMessage?(entry: SessionEntry, message: Message): Message;
  openUrl?(runtime: AgentRuntime, url: string, signal: AbortSignal): Promise<void>;
  prepareOpenInteraction?(runtime: AgentRuntime, request: Interaction['request'], assertOwnsPath: (path: string) => string, signal: AbortSignal): () => Promise<void>;
  resolveEnvironment(request: SessionEnvironmentRequest): Promise<SessionEnvironment>;
  configuration(packages: readonly string[]): Promise<readonly ExtensionConfigDefinition[]>;
  validateConfiguration(environment: SessionEnvironment, packages: readonly string[], overrides: readonly ExtensionConfigOverride[]): Promise<void>;
  prepare(request: SessionCompositionRequest): Promise<SessionComposition>;
  bindExtensions?(context: SessionExtensionContext, port: SessionExecutionPort): Promise<SessionExtensionBindings>;
}

export const SESSION_RUNTIME_SERVICE = defineServiceContract<SessionRuntime>('felan.session-runtime', 1);
