import {
  createAgentSession,
  type AgentSession,
  type AgentSessionServices,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type CreateAgentSessionRuntimeFactory,
  type CreateAgentSessionRuntimeResult,
  type InlineExtension,
  type ModelRuntime,
  type SessionManager,
  type SessionStartEvent,
  type SettingsManager,
  type Skill,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { loadFelanSessionExtensions, type ExtensionPackageImporter } from './extensions.js';
import { installModelSelectionPersistenceScope } from './model-selection.js';
import {
  createAgentCoreResourceLoaderWithContextFiles,
  runtimeToolsExtensionName,
} from './resource-loader.js';
import type { AgentRuntime } from './runtime.js';
import { createRuntimeCodingTools } from './tools.js';
import type { ExtensionConfigOverride } from './extension-config.js';

export type StreamFunction = AgentSession['agent']['streamFunction'];
const PROJECT_INSTRUCTION_FILENAMES = ['AGENTS.md', 'CLAUDE.md'] as const;
const decoder = new TextDecoder();

export interface CreateAgentCoreSessionOptions {
  readonly runtime: AgentRuntime;
  readonly wrapStreamFunction?: (original: StreamFunction) => StreamFunction;
  readonly extensionPackages: readonly string[];
  readonly importExtension: ExtensionPackageImporter;
  readonly extensionConfigOverrides?: readonly ExtensionConfigOverride[];
  readonly modelRuntime: ModelRuntime;
  readonly settingsManager: SettingsManager;
  readonly sessionManager: SessionManager;
  readonly agentDir?: string;
  readonly model?: CreateAgentSessionOptions['model'];
  readonly thinkingLevel?: CreateAgentSessionOptions['thinkingLevel'];
  readonly scopedModels?: CreateAgentSessionOptions['scopedModels'];
  readonly sessionStartEvent?: SessionStartEvent;
  readonly inlineExtensions?: readonly InlineExtension[];
  readonly customTools?: readonly ToolDefinition[];
  readonly skillPaths?: readonly string[];
  readonly skills?: readonly Skill[];
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
  const agentDir = options.agentDir ?? options.runtime.cwd;
  const modelSelectionScope = installModelSelectionPersistenceScope(options.settingsManager);
  const featureExtensions = await loadFelanSessionExtensions(
    options.extensionPackages,
    options.importExtension,
    options.runtime,
    agentDir,
    modelSelectionScope,
    options.extensionConfigOverrides,
  );
  const extensionFactories = [
    ...featureExtensions,
    ...(options.inlineExtensions ?? []),
    createRuntimeToolsExtension(options.runtime),
  ];
  const projectInstructions = await loadProjectInstructions(options.runtime);
  const resourceLoader = await createAgentCoreResourceLoaderWithContextFiles({
    cwd: options.runtime.cwd,
    agentDir,
    extensionFactories,
    ...(options.skillPaths === undefined ? {} : { skillPaths: options.skillPaths }),
    ...(options.skills === undefined ? {} : { skills: options.skills }),
    ...(projectInstructions === undefined ? {} : { contextFiles: [projectInstructions] }),
    ...(options.appendSystemPrompt === undefined
      ? {}
      : { appendSystemPrompt: options.appendSystemPrompt }),
  });
  const result = await createAgentSession({
    cwd: options.runtime.cwd,
    agentDir,
    modelRuntime: options.modelRuntime,
    noTools: 'builtin',
    ...(options.customTools === undefined ? {} : { customTools: [...options.customTools] }),
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

  try {
    if (options.wrapStreamFunction) {
      result.session.agent.streamFunction = options.wrapStreamFunction(result.session.agent.streamFunction);
    }
  } catch (error) {
    result.session.dispose();
    throw error;
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

async function loadProjectInstructions(runtime: AgentRuntime): Promise<{
  readonly path: string;
  readonly content: string;
} | undefined> {
  for (const filename of PROJECT_INSTRUCTION_FILENAMES) {
    try {
      const content = decoder.decode(await runtime.readFile(filename));
      if (content.trim().length === 0) return undefined;
      return {
        path: `${runtime.cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/${filename}`,
        content,
      };
    } catch {
      continue;
    }
  }
}

function createRuntimeToolsExtension(runtime: AgentRuntime): InlineExtension {
  return {
    name: runtimeToolsExtensionName,
    hidden: true,
    factory: (pi) => {
      for (const tool of createRuntimeCodingTools(runtime)) pi.registerTool(tool);
    },
  };
}
