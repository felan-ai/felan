import { AsyncLocalStorage } from 'node:async_hooks';
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
import { createTurnClassificationRegistry } from './classifier/turn-classification.js';
import { createDynamicThinkingSession, DYNAMIC_THINKING_PRODUCER } from './dynamic-thinking/session.js';
import { installModelSelectionPersistenceScope } from './model-selection.js';
import {
  createAgentCoreResourceLoaderWithContextFiles,
  runtimeToolsExtensionName,
} from './resource-loader.js';
import type { AgentRuntime } from './runtime.js';
import { createRuntimeCodingTools } from './tools.js';
import type { ExtensionConfigOverride } from './extension-config.js';
import type { SavingsReporter, SavingsReporterProvider } from './savings.js';

export type StreamFunction = AgentSession['agent']['streamFunction'];
const PROJECT_INSTRUCTION_FILENAMES = ['AGENTS.md', 'CLAUDE.md'] as const;
export const PROJECT_INSTRUCTIONS_CUSTOM_TYPE = 'felan-project-instructions';
const decoder = new TextDecoder();
const projectInstructionsByLoader = new WeakMap<object, ProjectInstructionsFile>();

export interface ProjectInstructionsFile {
  readonly path: string;
  readonly content: string;
}

export function getProjectInstructions(resourceLoader: object): ProjectInstructionsFile | undefined {
  return projectInstructionsByLoader.get(resourceLoader);
}

export interface CreateAgentCoreSessionOptions {
  readonly runtime: AgentRuntime;
  readonly wrapStreamFunction?: (original: StreamFunction) => StreamFunction;
  readonly extensionPackages: readonly string[];
  readonly importExtension: ExtensionPackageImporter;
  readonly extensionPaths?: readonly string[];
  readonly extensionConfigOverrides?: readonly ExtensionConfigOverride[];
  readonly modelRuntime: ModelRuntime;
  readonly settingsManager: SettingsManager;
  readonly sessionManager: SessionManager;
  readonly agentDir?: string;
  readonly model?: CreateAgentSessionOptions['model'];
  readonly thinkingLevel?: CreateAgentSessionOptions['thinkingLevel'];
  readonly dynamicThinking?: boolean;
  readonly scopedModels?: CreateAgentSessionOptions['scopedModels'];
  readonly sessionStartEvent?: SessionStartEvent;
  readonly inlineExtensions?: readonly InlineExtension[];
  readonly customTools?: readonly ToolDefinition[];
  readonly skillPaths?: readonly string[];
  readonly themePaths?: readonly string[];
  readonly skills?: readonly Skill[];
  readonly appendSystemPrompt?: readonly string[];
  readonly savings?: SavingsReporterProvider;
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
  const turnClassification = options.sessionManager.getHeader()?.parentSession === undefined && options.runtime.classifier
    ? createTurnClassificationRegistry(options.runtime.classifier, options.runtime.logger, () => modelSelectionScope.owner !== undefined)
    : undefined;
  const featureExtensions = await loadFelanSessionExtensions(
    options.extensionPackages,
    options.importExtension,
    options.runtime,
    agentDir,
    modelSelectionScope,
    options.extensionConfigOverrides,
    options.savings,
    turnClassification,
  );
  const projectInstructions = await loadProjectInstructions(options.runtime);
  const dynamicThinking = options.dynamicThinking && options.runtime.classifier
    ? createDynamicThinkingSession(options.runtime,
      featureExtensions.some((extension) => typeof extension !== 'function' && extension.name === '@felan-ai/ext-codex'),
      optionalDynamicThinkingReporter(options.savings), { selectionScope: modelSelectionScope, ...(turnClassification ? { turnClassification } : {}) })
    : undefined;
  const extensionFactories = [
    {
      name: '@felan-ai/agent-core/selection-automation',
      hidden: true,
      factory: (pi) => {
        modelSelectionScope.reset();
        const manualSelection = () => {
          if (!modelSelectionScope.isAutomated()) {
            modelSelectionScope.clearOwnership();
            turnClassification?.finish();
          }
        };
        pi.on('model_select', manualSelection);
        pi.on('thinking_level_select', manualSelection);
        modelSelectionScope.onManualThinkingSelection(manualSelection);
        pi.on('session_shutdown', () => modelSelectionScope.reset());
      },
    } satisfies InlineExtension,
    ...(turnClassification === undefined ? [] : [{
      name: '@felan-ai/agent-core/turn-classification',
      hidden: true,
      factory: (pi) => {
        turnClassification.reset();
        pi.on('input', (event, ctx) => {
          if (event.streamingBehavior !== undefined) return;
          turnClassification.start({ prompt: event.text, imageCount: event.images?.length ?? 0 }, ctx);
        });
        pi.on('before_agent_start', (event, ctx) => {
          turnClassification.start({ prompt: event.prompt, imageCount: event.images?.length ?? 0 }, ctx);
        });
        pi.on('turn_start', () => turnClassification.finish());
        pi.on('agent_settled', () => turnClassification.finish());
        pi.on('session_shutdown', () => turnClassification.dispose());
      },
    } satisfies InlineExtension]),
    ...(projectInstructions === undefined ? [] : [createProjectInstructionsExtension(projectInstructions)]),
    ...featureExtensions,
    ...(options.inlineExtensions ?? []),
    ...(dynamicThinking === undefined ? [] : [dynamicThinking]),
    createRuntimeToolsExtension(options.runtime),
  ];
  const resourceLoader = await createAgentCoreResourceLoaderWithContextFiles({
    cwd: options.runtime.cwd,
    agentDir,
    extensionFactories,
    ...(options.extensionPaths === undefined ? {} : { extensionPaths: options.extensionPaths }),
    ...(options.skillPaths === undefined ? {} : { skillPaths: options.skillPaths }),
    ...(options.themePaths === undefined ? {} : { themePaths: options.themePaths }),
    ...(options.skills === undefined ? {} : { skills: options.skills }),
    ...(options.appendSystemPrompt === undefined
      ? {}
      : { appendSystemPrompt: options.appendSystemPrompt }),
  });
  if (projectInstructions !== undefined) projectInstructionsByLoader.set(resourceLoader, projectInstructions);
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
  const modelSwitch = new AsyncLocalStorage<boolean>();
  const session = result.session;
  const setModel = session.setModel.bind(session);
  const cycleModel = session.cycleModel.bind(session);
  const setThinkingLevel = session.setThinkingLevel.bind(session);
  session.setModel = (...args) => modelSwitch.run(true, () => setModel(...args));
  session.cycleModel = (...args) => modelSwitch.run(true, () => cycleModel(...args));
  // Pi emits thinking_level_select only for changes; explicit no-ops still
  // override automation, unlike the implicit effort clamp inside model switches.
  session.setThinkingLevel = (...args) => {
    setThinkingLevel(...args);
    if (!modelSwitch.getStore() && !modelSelectionScope.isAutomated()) {
      modelSelectionScope.notifyManualThinkingSelection();
    }
  };
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

function optionalDynamicThinkingReporter(provider: SavingsReporterProvider | undefined): SavingsReporter | undefined {
  try {
    return provider?.createReporter(DYNAMIC_THINKING_PRODUCER);
  } catch {
    return undefined;
  }
}

async function loadProjectInstructions(runtime: AgentRuntime): Promise<ProjectInstructionsFile | undefined> {
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

function createProjectInstructionsExtension(file: ProjectInstructionsFile): InlineExtension {
  const content = `# Project instructions from ${JSON.stringify(file.path)}\n\n<INSTRUCTIONS>\n${file.content}\n</INSTRUCTIONS>`;
  const timestamp = Date.now();
  return {
    name: '@felan-ai/agent-core/project-instructions',
    hidden: true,
    factory: (pi) => {
      pi.on('context', (event) => {
        const messages = event.messages.filter((message) => (
          message.role !== 'custom' || message.customType !== PROJECT_INSTRUCTIONS_CUSTOM_TYPE
        ));
        const existing = event.messages.find((message) => (
          message.role === 'custom' && message.customType === PROJECT_INSTRUCTIONS_CUSTOM_TYPE
        ));
        if (existing && event.messages[0] === existing && messages.length === event.messages.length - 1) {
          return;
        }
        return {
          messages: [
            {
              role: 'custom',
              customType: PROJECT_INSTRUCTIONS_CUSTOM_TYPE,
              content,
              details: { path: file.path, content: file.content, contextText: content },
              display: false,
              timestamp,
            },
            ...messages,
          ],
        };
      });
    },
  };
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
