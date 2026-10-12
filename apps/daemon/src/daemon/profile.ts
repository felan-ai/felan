import type {
  AgentRuntime,
  AgentSession,
  AgentSessionRuntime,
  AgentSessionRuntimeDiagnostic,
  CreateAgentSessionOptions,
  CreateAgentCoreSessionOptions,
  ExtensionConfigDefinition,
  ExtensionConfigOverride,
  ExtensionConfigValue,
  ExtensionPackageImporter,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@felan-ai/agent-core';
import type { SessionBranchCursor } from './session-cursor.js';
export type { SessionBranchCursor } from './session-cursor.js';

export const DAEMON_PROFILE_API_VERSION = 1;

export interface ProfileResourceRequest {
  readonly cwd: string;
  readonly sessionDir?: string;
}

export interface ProfileResources {
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly sessionStorageBase: string;
  readonly agentStorageRoot: string;
  readonly subagentRoot: string;
  readonly memoryRoot: string;
  readonly writableRoots: readonly string[];
}

export interface ProfileOwnership {
  // The registry must hold the source-session and destination-directory claims before opening; calls are idempotent.
  assertOwned(resources: ProfileResources, target: ProfileTargetIdentity): void | Promise<void>;
}

export interface ProfileTargetIdentity {
  readonly kind: ProfileSessionTarget['kind'];
  readonly destinationDirectory: string;
  readonly sourceSessionFile?: string;
  readonly sourceSessionId?: string;
}

export interface ToolProvenance {
  readonly name: string;
  readonly source: 'builtin' | 'external';
  readonly sourceId: string;
}

export interface SessionExecutionPolicy {
  readonly mode: 'host-default' | 'acp-strict';
  readonly pendingTightening: boolean;
  readonly generation: number;
}

export interface ProfileExtensionContext {
  readonly runtime: AgentRuntime;
  readonly modelRuntime: ModelRuntime;
  readonly settingsManager: SettingsManager;
  readonly sessionManager: SessionManager;
  readonly resources: ProfileResources;
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
}

export interface ProfileExtensionBindings {
  readonly importExtension: ExtensionPackageImporter;
  readonly inlineExtensions?: CreateAgentCoreSessionOptions['inlineExtensions'];
  readonly extensionPaths?: readonly string[];
  readonly savings?: CreateAgentCoreSessionOptions['savings'];
  readonly wrapStreamFunction?: CreateAgentCoreSessionOptions['wrapStreamFunction'];
  readonly uiContext?: NonNullable<Parameters<AgentSession['bindExtensions']>[0]>['uiContext'];
  readonly onSession?: (session: AgentSession) => void | Promise<void>;
  /** Settle owned work before Pi session disposal; keep shutdown presentation usable. */
  readonly dispose: () => Promise<void>;
  /** Release presentation only after asynchronous session shutdown handlers settle. */
  readonly disposeUi?: () => void;
}

export interface DaemonSessionServices {
  readonly getExecutionPolicy: () => SessionExecutionPolicy;
  readonly extensions: {
    configuration(packages: readonly string[]): Promise<readonly ExtensionConfigDefinition[]>;
    bind(context: ProfileExtensionContext): Promise<ProfileExtensionBindings>;
  };
}

export type ProfileSessionTarget =
  | { readonly kind: 'new' }
  | { readonly kind: 'resume'; readonly sessionFile: string; readonly cursor?: SessionBranchCursor }
  | { readonly kind: 'fork'; readonly sourceSessionFile: string; readonly entryId: string; readonly position: 'before' | 'at' }
  | { readonly kind: 'clone'; readonly sourceSessionFile: string }
  | { readonly kind: 'import'; readonly sessionFile: string };

export interface ProfileOpenRequest {
  readonly resources: ProfileResources;
  readonly ownership: ProfileOwnership;
  readonly policy: SessionExecutionPolicy;
  readonly services: DaemonSessionServices;
  readonly target: ProfileSessionTarget;
  readonly rootSessionId?: string;
  readonly parentSessionId?: string;
  readonly model?: CreateAgentSessionOptions['model'];
  readonly thinkingLevel?: CreateAgentSessionOptions['thinkingLevel'];
  readonly extensionConfigOverrides?: readonly ExtensionConfigOverride[];
  readonly source?: 'tui' | 'acp' | 'headless';
  readonly extensionPaths?: readonly string[];
}

export interface ProfileSessionBinding {
  readonly runtime: AgentSessionRuntime;
  readonly agentRuntime: AgentRuntime;
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly parentSessionId?: string;
  readonly resources: ProfileResources;
  readonly diagnostics: readonly AgentSessionRuntimeDiagnostic[];
  readonly activate?: () => Promise<void>;
  readonly toolProvenance: readonly ToolProvenance[];
  readonly tools: {
    readonly provenance: readonly ToolProvenance[];
    requiresApproval(policy: SessionExecutionPolicy, name: string): boolean;
  };
}

export interface DaemonProfile {
  readonly apiVersion: typeof DAEMON_PROFILE_API_VERSION;
  readonly id: string;
  resolveResources(request: ProfileResourceRequest): Promise<ProfileResources>;
  validateConfiguration?(resources: ProfileResources, overrides: readonly ExtensionConfigOverride[], configuration: DaemonSessionServices['extensions']['configuration']): Promise<void>;
  openSession(request: ProfileOpenRequest): Promise<ProfileSessionBinding>;
  dispose(): Promise<void>;
}
