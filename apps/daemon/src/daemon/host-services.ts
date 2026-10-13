import type { AgentRuntime, ExtensionConfigDefinition, ExtensionConfigOverride, ModelRuntime, RuntimeDependencyInstallResult } from '@felan-ai/agent-core';
import type { JsonValue, OperationParams, OperationResult, SetupCatalog, SetupJob, SetupStart, TuiPreferences, TuiPreferencesUpdate } from '@felan-ai/session-protocol';
import type { InteractionBroker } from './broker.js';

export interface HostConfiguration {
  get(scope: OperationParams<'config.get'>['scope']): Promise<OperationResult<'config.get'>>;
  set(scope: OperationParams<'config.set'>['scope'], input: unknown): Promise<void>;
  prepare(scope: OperationParams<'config.set'>['scope'], input: unknown): void;
  sessionOverrides(input: unknown, previous?: readonly ExtensionConfigOverride[]): { extensionId: string; source: string; values: Record<string, JsonValue> }[];
  sessionValues(overrides: readonly ExtensionConfigOverride[]): Promise<OperationResult<'config.get'>>;
}

export interface HostPreferences {
  get(): Promise<TuiPreferences>;
  set(value: TuiPreferencesUpdate): Promise<void>;
}

export interface HostSetup {
  dependency(id: string): { readonly label: string; readonly description: string } | undefined;
  installApprovedDependency(id: string, signal?: AbortSignal): Promise<RuntimeDependencyInstallResult>;
  catalog(): Promise<SetupCatalog>;
  validateStart(value: SetupStart): void;
  start(request: SetupStart, client: string): SetupJob;
  read(id: string, client: string): SetupJob;
  answer(id: string, promptId: string, text: string, client: string): Promise<void>;
  cancel(id: string, client: string): void;
  prepareOpenLink(id: string, index: number, client: string): () => Promise<void>;
  disconnected(client: string): void;
  beginDrain(): void;
  drain(): Promise<void>;
}

export interface HostServices {
  readonly configuration: HostConfiguration;
  readonly preferences?: HostPreferences;
  readonly setup: HostSetup;
  prepareRoot?(params: OperationParams<'sessions.create'>, caller: {
    id: string; kind: OperationParams<'hello'>['kind']; localConsole: boolean; signal: AbortSignal;
  }): Promise<{ cwd: string; extensionPaths: readonly string[] }>;
}

export interface HostServicesRequest {
  readonly agentDir: string;
  readonly homeDir: string;
  readonly runtime: AgentRuntime;
  readonly models: ModelRuntime;
  readonly definitions: readonly ExtensionConfigDefinition[];
  readonly interactions: Pick<InteractionBroker, 'request'>;
  assertCurrent(): void;
}

