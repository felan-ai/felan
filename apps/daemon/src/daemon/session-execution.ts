import type { AgentRuntime, AgentSession, CreateAgentCoreSessionOptions, ExtensionConfigOverride, ExtensionConfigValue, ExtensionPackageImporter, FelanServiceRegistry, ModelRuntime, SessionManager, SessionRef, SettingsManager } from '@felan-ai/agent-core';
import type { Interaction, InteractionAnswer, InteractionAuthority, Presentation } from '@felan-ai/session-protocol';
import type { SessionEnvironment } from './session-runtime.js';
import type { SessionExecutionPolicy } from './session-lifecycle-contracts.js';
import type { ProviderWorkerLauncher } from './provider.js';
import type { ExecutionHost, ExecutionParentPort, ExecutionSettings } from './executions.js';
import type { UiVocabulary } from './ui-vocabulary.js';

export interface SessionUiPort {
  request(request: Interaction['request'], options?: { readonly signal?: AbortSignal; readonly timeout?: number; readonly deferrable?: boolean; readonly transient?: boolean; readonly audience?: 'session' | 'owner' | 'host'; readonly authority?: InteractionAuthority }): Promise<
    { state: 'answered'; answer: InteractionAnswer } | { state: 'cancelled'; reason: 'user' | 'abort' | 'timeout' | 'unsupported' | 'drain' | 'restart' } | { state: 'deferred'; interactionId: string }>;
  canPresent(request: Interaction['request'], audience?: 'session' | 'owner' | 'host'): boolean;
  subscribeClients(listener: () => void): () => void;
}


export interface SessionExtensionContext {
  readonly runtime: AgentRuntime;
  readonly modelRuntime: ModelRuntime;
  readonly settingsManager: SettingsManager;
  readonly sessionManager: SessionManager;
  readonly resources: SessionEnvironment;
  readonly rootSessionId: string;
  readonly policy: SessionExecutionPolicy;
  readonly extensionPackages: readonly string[];
  readonly source: 'tui' | 'acp' | 'headless';
  readonly extensionConfigs: ReadonlyMap<string, Readonly<Record<string, ExtensionConfigValue>>>;
  readonly extensionConfigOverrides: readonly ExtensionConfigOverride[];
  readonly scopedModels: NonNullable<CreateAgentCoreSessionOptions['scopedModels']>;
  readonly skillPaths: readonly string[];
  readonly classifier: AgentRuntime['classifier'];
  readonly dynamicThinking: boolean;
  readonly services: FelanServiceRegistry;
  readonly importExtension: ExtensionPackageImporter;
}

export interface SessionExtensionBindings {
  readonly importExtension: ExtensionPackageImporter;
  readonly inlineExtensions?: CreateAgentCoreSessionOptions['inlineExtensions'];
  readonly extensionPaths?: readonly string[];
  readonly savings?: CreateAgentCoreSessionOptions['savings'];
  readonly wrapStreamFunction?: CreateAgentCoreSessionOptions['wrapStreamFunction'];
  readonly uiContext?: NonNullable<Parameters<AgentSession['bindExtensions']>[0]>['uiContext'];
  readonly createExtensionUi?: CreateAgentCoreSessionOptions['createExtensionUi'];
  readonly onSession?: (session: AgentSession) => void | Promise<void>;
  readonly dispose: () => Promise<void>;
  readonly disposeUi?: () => void | Promise<void>;
  readonly services?: FelanServiceRegistry;
}

export interface SessionExecutionPort {
  readonly current: SessionRef;
  readonly providerContext?: unknown;
  readonly ui: SessionUiPort;
  readonly openWorker: ProviderWorkerLauncher;
  ensureRoot(): Promise<void>;
  assertCurrent(): void;
  assertOwnsPath(path: string): string;
  assertNewWork(parent: string): void;
  assertDispatch(session: string): void;
  activatePolicy(): void;
  session(id: string): AgentSession | undefined;
  executions(): ExecutionHost;
  configureExecutions(settings: ExecutionSettings): void;
  attachExecutionParent(port: ExecutionParentPort): () => void;
  registerService(service: { readonly disposeWhenIdle?: boolean; busy(): boolean; settle(mode?: 'drain' | 'force'): Promise<void>; dispose(): Promise<void> }): () => void;
  registerUiActions(prepare: UiVocabulary['prepareAction']): () => void;
  publish(value: Presentation | { id: string; remove: true }): void;
  fail(error: unknown): void;
}
