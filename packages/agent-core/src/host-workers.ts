import type { AgentSession, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { CreateAgentCoreSessionOptions } from './session.js';
import type { ModelReference } from './model-tiers.js';
import type { AgentRuntime } from './runtime.js';
import { defineServiceContract } from './services.js';

/** In-process host composition only; not a portable session service or wire contract. */
export interface HostWorkerOptions {
  readonly runtime: AgentRuntime;
  readonly sessionManager: SessionManager;
  readonly settingsManager: SettingsManager;
  readonly model: ModelReference;
  readonly thinkingLevel?: CreateAgentCoreSessionOptions['thinkingLevel'];
  readonly customTools?: CreateAgentCoreSessionOptions['customTools'];
  readonly appendSystemPrompt?: CreateAgentCoreSessionOptions['appendSystemPrompt'];
  readonly allowedTools: readonly string[];
  readonly signal?: AbortSignal;
}

export type HostWorker = Pick<AgentSession,
  'abort' | 'bindExtensions' | 'getActiveToolNames' | 'messages' | 'prompt' | 'subscribe' | 'setActiveToolsByName' | 'thinkingLevel'>
  & { dispose(): Promise<void> };

export type HostWorkerLauncher = (input: HostWorkerOptions) => Promise<HostWorker>;

export interface RuntimeLifecycle {
  busy(): boolean;
  settle(mode: 'drain' | 'force'): Promise<void>;
  dispose(): Promise<void>;
}

export interface RuntimeLifetime {
  register(lifecycle: RuntimeLifecycle): () => void;
}

export const HOST_WORKERS_SERVICE = defineServiceContract<HostWorkerLauncher>('felan.host.workers', 1);
export const RUNTIME_LIFETIME_SERVICE = defineServiceContract<RuntimeLifetime>('felan.runtime.lifetime', 1);

