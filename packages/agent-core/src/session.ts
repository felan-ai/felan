import {
  createAgentSession,
  type AgentSession,
  type AgentSessionServices,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type CreateAgentSessionRuntimeFactory,
  type CreateAgentSessionRuntimeResult,
  type ModelRuntime,
  type SessionManager,
  type SessionStartEvent,
  type SettingsManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { loadFelanExtensions, type ExtensionPackageImporter } from './extensions.js';
import { createAgentCoreResourceLoader } from './resource-loader.js';
import type { AgentRuntime } from './runtime.js';
import { createRuntimeCodingTools } from './tools.js';

export type StreamFunction = AgentSession['agent']['streamFunction'];

export interface AgentSessionHost {
  wrapStreamFunction?(original: StreamFunction): StreamFunction;
  createChildSession(request: AgentChildSessionRequest): Promise<AgentChildSessionResult>;
}

export interface AgentChildSessionRequest {
  readonly rootSessionId: string;
  readonly parentSessionId: string;
  readonly personaId: string;
  readonly prompt: string;
  readonly block: boolean;
  readonly model?: string;
  readonly timeoutMinutes?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AgentChildSessionResult {
  readonly ok: boolean;
  readonly sessionId: string;
  readonly status: 'running' | 'queued' | 'completed' | 'failed';
  readonly result?: string;
  readonly error?: string;
  readonly message?: string;
}

export interface CreateAgentCoreSessionOptions {
  readonly applicationKind: 'cloud' | 'tui';
  readonly runtime: AgentRuntime;
  readonly host: AgentSessionHost;
  readonly extensionPackages: readonly string[];
  readonly importExtension: ExtensionPackageImporter;
  readonly extensionFlagValues?: ReadonlyMap<string, boolean | string>;
  readonly modelRuntime: ModelRuntime;
  readonly settingsManager: SettingsManager;
  readonly sessionManager: SessionManager;
  readonly agentDir?: string;
  readonly model?: CreateAgentSessionOptions['model'];
  readonly thinkingLevel?: CreateAgentSessionOptions['thinkingLevel'];
  readonly scopedModels?: CreateAgentSessionOptions['scopedModels'];
  readonly sessionStartEvent?: SessionStartEvent;
  readonly customTools?: readonly ToolDefinition[];
  readonly systemPrompt?: string;
  readonly appendSystemPrompt?: readonly string[];
}

export async function createAgentCoreSession(
  options: CreateAgentCoreSessionOptions,
): Promise<CreateAgentSessionResult> {
  const composition = await composeAgentCoreSession(options);
  return composition.result;
}

export async function createAgentCoreSessionRuntime(
  options: CreateAgentCoreSessionOptions,
): Promise<CreateAgentSessionRuntimeResult> {
  const composition = await composeAgentCoreSession(options);
  return {
    ...composition.result,
    services: composition.services,
    diagnostics: composition.services.diagnostics,
  };
}

export type AgentCoreSessionRuntimeFactoryRequest = Parameters<CreateAgentSessionRuntimeFactory>[0];

export type AgentCoreSessionRuntimeFactoryOptions = Omit<
  CreateAgentCoreSessionOptions,
  'agentDir' | 'sessionManager' | 'sessionStartEvent'
>;

export type AgentCoreSessionRuntimeOptionsFactory = (
  request: AgentCoreSessionRuntimeFactoryRequest,
) => AgentCoreSessionRuntimeFactoryOptions | Promise<AgentCoreSessionRuntimeFactoryOptions>;

export function createAgentCoreSessionRuntimeFactory(
  createOptions: AgentCoreSessionRuntimeOptionsFactory,
): CreateAgentSessionRuntimeFactory {
  return async (request) => createAgentCoreSessionRuntime({
    ...await createOptions(request),
    agentDir: request.agentDir,
    sessionManager: request.sessionManager,
    ...(request.sessionStartEvent === undefined
      ? {}
      : { sessionStartEvent: request.sessionStartEvent }),
  });
}

interface AgentCoreSessionComposition {
  readonly result: CreateAgentSessionResult;
  readonly services: AgentSessionServices;
}

async function composeAgentCoreSession(
  options: CreateAgentCoreSessionOptions,
): Promise<AgentCoreSessionComposition> {
  const extensionFactories = await loadFelanExtensions(
    options.extensionPackages,
    options.importExtension,
    options.runtime,
  );
  const agentDir = options.agentDir ?? options.runtime.cwd;
  const resourceLoader = await createAgentCoreResourceLoader({
    cwd: options.runtime.cwd,
    agentDir,
    extensionFactories,
    ...(options.extensionFlagValues === undefined
      ? {}
      : { extensionFlagValues: options.extensionFlagValues }),
    ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
    ...(options.appendSystemPrompt === undefined
      ? {}
      : { appendSystemPrompt: options.appendSystemPrompt }),
  });
  const customTools = [
    ...createRuntimeCodingTools(options.runtime),
    ...(options.customTools ?? []),
  ];
  const result = await createAgentSession({
    cwd: options.runtime.cwd,
    agentDir,
    modelRuntime: options.modelRuntime,
    noTools: 'builtin',
    customTools,
    resourceLoader,
    sessionManager: options.sessionManager,
    settingsManager: options.settingsManager,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
    ...(options.scopedModels === undefined ? {} : { scopedModels: options.scopedModels }),
    ...(options.sessionStartEvent === undefined
      ? {}
      : { sessionStartEvent: options.sessionStartEvent }),
  });

  if (options.host.wrapStreamFunction) {
    const wrapped = options.host.wrapStreamFunction(result.session.agent.streamFunction);
    if (typeof wrapped !== 'function') {
      throw new Error('AgentSessionHost.wrapStreamFunction must return a stream function');
    }
    result.session.agent.streamFunction = wrapped;
  }

  return {
    result,
    services: {
      cwd: options.runtime.cwd,
      agentDir,
      modelRuntime: options.modelRuntime,
      settingsManager: options.settingsManager,
      resourceLoader,
      diagnostics: [],
    },
  };
}
