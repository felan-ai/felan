import type {
  AgentRuntime,
  AgentSessionRuntime,
  AgentSessionRuntimeDiagnostic,
  CreateAgentSessionOptions,
  CreateAgentCoreSessionOptions,
  ExtensionConfigDefinition,
  ExtensionConfigOverride,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@felan-ai/agent-core';
import type { SessionEnvironment, SessionRuntime } from './session-runtime.js';
import type { SessionExtensionBindings, SessionExtensionContext, SessionExecutionPort } from './session-execution.js';

export const SESSION_LIFECYCLE_API_VERSION = 1;

export interface SessionResourceRequest {
  readonly cwd: string;
  readonly sessionDir?: string;
}

export type SessionResources = SessionEnvironment;

export interface SessionOwnership {
  // The registry must hold the source-session and destination-directory claims before opening; calls are idempotent.
  assertOwned(resources: SessionResources, target: SessionTargetIdentity): void | Promise<void>;
}

export interface SessionTargetIdentity {
  readonly kind: SessionTarget['kind'];
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
  readonly generation: number;
}

export interface DaemonSessionServices {
  readonly getExecutionPolicy: () => SessionExecutionPolicy;
  currentRun(rootSessionId: string): ReturnType<SessionExtensionContext['currentRun']>;
  readonly extensions: {
    configuration(packages: readonly string[]): Promise<readonly ExtensionConfigDefinition[]>;
    executionPort?(context: SessionExtensionContext): SessionExecutionPort;
    bind(context: SessionExtensionContext, port?: SessionExecutionPort): Promise<SessionExtensionBindings>;
  };
}

export type SessionTarget =
  | { readonly kind: 'new'; readonly id?: string }
  | { readonly kind: 'resume'; readonly sessionFile: string }
  | { readonly kind: 'fork'; readonly sourceSessionFile: string; readonly entryId: string; readonly position: 'before' | 'at' }
  | { readonly kind: 'clone'; readonly sourceSessionFile: string }
  | { readonly kind: 'import'; readonly sessionFile: string };

export interface SessionOpenRequest {
  readonly resources: SessionResources;
  readonly ownership: SessionOwnership;
  readonly policy: SessionExecutionPolicy;
  readonly services: DaemonSessionServices;
  readonly target: SessionTarget;
  readonly rootSessionId?: string;
  readonly parentSessionId?: string;
  readonly execution?: { readonly label?: string };
  readonly model?: CreateAgentSessionOptions['model'];
  readonly thinkingLevel?: CreateAgentSessionOptions['thinkingLevel'];
  readonly extensionConfigOverrides?: readonly ExtensionConfigOverride[];
  readonly extensionPaths?: readonly string[];
  readonly allowedTools?: readonly string[];
  readonly instructions?: string;
  readonly worker?: SessionWorkerConfiguration;
}

export interface SessionWorkerConfiguration {
  readonly runtime: AgentRuntime;
  readonly modelRuntime: ModelRuntime;
  readonly sessionManager: SessionManager;
  readonly model: NonNullable<CreateAgentCoreSessionOptions['model']>;
  readonly thinkingLevel?: CreateAgentCoreSessionOptions['thinkingLevel'];
  readonly settingsManager: SettingsManager;
  readonly customTools?: CreateAgentCoreSessionOptions['customTools'];
  readonly appendSystemPrompt?: CreateAgentCoreSessionOptions['appendSystemPrompt'];
  readonly allowedTools: readonly string[];
}

export interface SessionBinding {
  readonly runtime: AgentSessionRuntime;
  readonly agentRuntime: AgentRuntime;
  readonly sessionId: string;
  readonly rootSessionId: string;
  readonly parentSessionId?: string;
  readonly resources: SessionResources;
  readonly diagnostics: readonly AgentSessionRuntimeDiagnostic[];
  readonly activate?: () => Promise<void>;
  readonly projectMessage?: SessionRuntime['projectMessage'];
  readonly toolProvenance: readonly ToolProvenance[];
  readonly tools: {
    readonly provenance: readonly ToolProvenance[];
    requiresApproval(policy: SessionExecutionPolicy, name: string): boolean;
  };
}

export interface SessionLifecycle {
  readonly apiVersion: typeof SESSION_LIFECYCLE_API_VERSION;
  readonly id: string;
  resolveResources(request: SessionResourceRequest): Promise<SessionResources>;
  validateConfiguration?(resources: SessionResources, overrides: readonly ExtensionConfigOverride[], configuration: DaemonSessionServices['extensions']['configuration']): Promise<void>;
  openSession(request: SessionOpenRequest): Promise<SessionBinding>;
  dispose(): Promise<void>;
}
