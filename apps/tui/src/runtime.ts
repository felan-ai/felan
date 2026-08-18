import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  AGENT_CORE_VERSION,
  HostAgentRuntime,
  ModelRuntime,
  SessionManager,
  bindFelanExtension,
  createAgentCoreSessionRuntimeFactory,
  createAgentSessionRuntime,
  type AgentSessionServices,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionPackageImporter,
} from '@felan-ai/agent-core';
import { bindSubagentSession } from '@felan-ai/ext-subagents';
import {
  resolveModelScopeWithDiagnostics,
  type AgentSessionRuntime,
} from '@earendil-works/pi-coding-agent';
import { createLocalCodexStreamFunctionWrapper } from './codex.js';
import {
  createLocalDependencyExtension,
  localDependencyExtensionName,
} from './dependencies.js';
import {
  createLocalExtensionImporter,
  importLocalExtension,
  resolveBuiltinExtensionPackages,
} from './extensions.js';
import {
  createLocalSettingsManager,
  getFelanSettings,
  getLocalToolDisplayMode,
} from './settings.js';
import { loadLocalAppendSystemPrompt } from './system-prompt.js';
import {
  createLocalAgentRuntimeFactoryRequest,
  type LocalAgentRuntimeFactory,
} from './runtime-factory.js';
import {
  LocalSubagentHost,
  type LocalSubagentSettings,
} from './subagents/host.js';
import { createToolActivityExtension } from './tool-activity/extension.js';
import { registerToolActivitySession } from './tool-activity/runtime-view.js';
import { ToolActivityState } from './tool-activity/state.js';

const localSubagentHost = Symbol('localSubagentHost');
const localSubagentShutdown = Symbol('localSubagentShutdown');

interface LocalSubagentShutdownState {
  failed: boolean;
  error?: unknown;
}

type LocalServices = AgentSessionServices & {
  [localSubagentHost]?: LocalSubagentHost;
  [localSubagentShutdown]?: LocalSubagentShutdownState;
};

export type LocalFelanRuntime = AgentSessionRuntime & {
  readonly localSubagentHost: LocalSubagentHost;
  subscribeLocalSubagentHost(listener: (host: LocalSubagentHost) => void): () => void;
};

export interface CreateLocalSessionRuntimeFactoryOptions {
  readonly agentDir: string;
  readonly homeDir?: string;
  readonly modelRuntime: ModelRuntime;
  readonly extensionPackages?: readonly string[];
  readonly importExtension?: ExtensionPackageImporter;
  readonly runtimeFactory?: LocalAgentRuntimeFactory;
  readonly skillPaths?: readonly string[];
  readonly subagentSettings?: LocalSubagentSettings;
}

export interface CreateLocalFelanRuntimeOptions {
  readonly cwd?: string;
  readonly agentDir?: string;
  readonly homeDir?: string;
  readonly continueRecent?: boolean;
  readonly sessionManager?: SessionManager;
  readonly modelRuntime?: ModelRuntime;
  readonly sessionDir?: string;
  readonly runtimeFactory?: LocalAgentRuntimeFactory;
  readonly skillPaths?: readonly string[];
  readonly subagentSettings?: LocalSubagentSettings;
}

export function getLocalAgentDir(): string {
  return resolve(process.env.FELAN_AGENT_DIR ?? join(homedir(), '.felan'));
}

export function getLocalSkillPaths(cwd: string, homeDir: string = homedir()): readonly string[] {
  return [...new Set([
    resolve(cwd, '.agents', 'skills'),
    resolve(homeDir, '.agents', 'skills'),
  ])].filter((path) => existsSync(path));
}

export function createLocalSessionRuntimeFactory(
  options: CreateLocalSessionRuntimeFactoryOptions,
): CreateAgentSessionRuntimeFactory {
  const sessions = new WeakMap<SessionManager, {
    host: LocalSubagentHost;
    modelScope: Awaited<ReturnType<typeof resolveModelScopeWithDiagnostics>>;
    shutdownState: LocalSubagentShutdownState;
    toolActivityState: ToolActivityState;
  }>();
  const createCoreRuntime = createAgentCoreSessionRuntimeFactory(async ({ cwd, sessionManager }) => {
    const runtimeRequest = createLocalAgentRuntimeFactoryRequest(
      cwd,
      options.agentDir,
      sessionManager.getSessionId(),
    );
    await Promise.all([
      mkdir(runtimeRequest.sessionStorageRoot, { recursive: true }),
      mkdir(runtimeRequest.agentStorageRoot, { recursive: true }),
    ]);
    const settingsManager = createLocalSettingsManager(cwd, options.agentDir);
    const felanSettings = getFelanSettings(settingsManager);
    const toolActivityState = new ToolActivityState(getLocalToolDisplayMode(settingsManager));
    const reloadSettings = settingsManager.reload.bind(settingsManager);
    settingsManager.reload = async () => {
      await reloadSettings();
      toolActivityState.setMode(getLocalToolDisplayMode(settingsManager));
    };
    const modelPatterns = settingsManager.getEnabledModels();
    const modelScope = modelPatterns && modelPatterns.length > 0
      ? await resolveModelScopeWithDiagnostics(modelPatterns, options.modelRuntime)
      : { scopedModels: [], diagnostics: [] };
    const extensionPackages = options.extensionPackages
      ?? resolveBuiltinExtensionPackages(felanSettings.builtinExtensions);
    const importExtension = options.importExtension ?? importLocalExtension;
    const skillPaths = options.skillPaths ?? getLocalSkillPaths(cwd, options.homeDir);
    const subagentSettings = options.subagentSettings ?? felanSettings.felanSubagents;
    const appendSystemPrompt = await loadLocalAppendSystemPrompt(options.agentDir);
    const runtime = options.runtimeFactory?.(runtimeRequest)
      ?? new HostAgentRuntime(cwd, runtimeRequest);
    const dependencyExtension = bindFelanExtension(
      localDependencyExtensionName,
      createLocalDependencyExtension({ agentDir: options.agentDir, settingsManager }),
      runtime,
      options.agentDir,
    );
    if (typeof dependencyExtension !== 'function') dependencyExtension.hidden = true;
    const wrapStreamFunction = await createLocalCodexStreamFunctionWrapper(
      extensionPackages,
      runtime,
      options.agentDir,
    );
    const host = await LocalSubagentHost.create({
      sessionId: sessionManager.getSessionId(),
      cwd,
      agentDir: options.agentDir,
      ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
      modelRuntime: options.modelRuntime,
      settingsManager,
      extensionPackages,
      importExtension,
      skillPaths,
      ...(options.runtimeFactory === undefined ? {} : { runtimeFactory: options.runtimeFactory }),
      ...(subagentSettings === undefined ? {} : { settings: subagentSettings }),
    });
    const shutdownState: LocalSubagentShutdownState = { failed: false };
    const shutdownHost = async () => {
      try {
        await host.shutdown();
      } catch (error) {
        shutdownState.failed = true;
        shutdownState.error = error;
        throw error;
      }
    };
    sessions.set(sessionManager, {
      host,
      modelScope,
      shutdownState,
      toolActivityState,
    });

    return {
      runtime,
      ...(wrapStreamFunction === undefined ? {} : { wrapStreamFunction }),
      extensionPackages,
      importExtension: createLocalExtensionImporter(
        host,
        options.modelRuntime,
        importExtension,
        shutdownHost,
      ),
      modelRuntime: options.modelRuntime,
      settingsManager,
      skillPaths,
      inlineExtensions: [dependencyExtension, createToolActivityExtension(toolActivityState)],
      ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt: [appendSystemPrompt] }),
      ...(modelScope.scopedModels.length === 0 ? {} : { scopedModels: modelScope.scopedModels }),
    };
  });

  return async (request) => {
    const result = await createCoreRuntime(request);
    const {
      host,
      modelScope,
      shutdownState,
      toolActivityState,
    } = sessions.get(request.sessionManager)!;
    toolActivityState.attach(result.session);
    registerToolActivitySession(result.session, toolActivityState);
    bindSubagentSession({ host, session: result.session });
    Object.defineProperty(result.services, localSubagentHost, { value: host });
    Object.defineProperty(result.services, localSubagentShutdown, { value: shutdownState });
    const settingsErrors = result.services.settingsManager.drainErrors();

    return {
      ...result,
      diagnostics: [
        { type: 'info', message: `Agent Core version: ${AGENT_CORE_VERSION}` },
        ...result.diagnostics,
        ...modelScope.diagnostics,
        ...settingsErrors.map(({ scope, error }) => ({
          type: 'warning' as const,
          message: `${scope} settings: ${error.message}`,
        })),
      ],
    };
  };
}

export async function createLocalModelRuntime(agentDir: string): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
  });
}

export async function createLocalFelanRuntime(
  options: CreateLocalFelanRuntimeOptions = {},
): Promise<LocalFelanRuntime> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const agentDir = resolve(options.agentDir ?? getLocalAgentDir());
  await mkdir(agentDir, { recursive: true });
  const modelRuntime = options.modelRuntime ?? await createLocalModelRuntime(agentDir);
  const startupSettings = createLocalSettingsManager(cwd, agentDir);
  const sessionDir = options.sessionDir ?? startupSettings.getSessionDir() ?? join(agentDir, 'sessions');
  const sessionManager = options.sessionManager
    ?? (options.continueRecent
      ? SessionManager.continueRecent(cwd, sessionDir)
      : SessionManager.create(cwd, sessionDir));
  const createRuntime = createLocalSessionRuntimeFactory({
    agentDir,
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    modelRuntime,
    ...(options.runtimeFactory === undefined ? {} : { runtimeFactory: options.runtimeFactory }),
    ...(options.skillPaths === undefined ? {} : { skillPaths: options.skillPaths }),
    ...(options.subagentSettings === undefined ? {} : { subagentSettings: options.subagentSettings }),
  });

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: sessionManager.getCwd(),
    agentDir,
    sessionManager,
  });
  return installLocalSubagentLifecycle(runtime);
}

function getRuntimeLocalSubagentHost(runtime: { readonly services: AgentSessionServices }): LocalSubagentHost {
  const host = (runtime.services as LocalServices)[localSubagentHost];
  if (!host) throw new Error('Local subagent host is unavailable');
  return host;
}

function getRuntimeLocalSubagentShutdown(
  runtime: { readonly services: AgentSessionServices },
): LocalSubagentShutdownState {
  const state = (runtime.services as LocalServices)[localSubagentShutdown];
  if (!state) throw new Error('Local subagent shutdown state is unavailable');
  return state;
}

function installLocalSubagentLifecycle(runtime: AgentSessionRuntime): LocalFelanRuntime {
  const listeners = new Set<(host: LocalSubagentHost) => void>();
  const localRuntime = runtime as LocalFelanRuntime;
  Object.defineProperties(localRuntime, {
    localSubagentHost: { get: () => getRuntimeLocalSubagentHost(runtime) },
    subscribeLocalSubagentHost: {
      value: (listener: (host: LocalSubagentHost) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
  const notifyHostReplacement = () => {
    const host = localRuntime.localSubagentHost;
    for (const listener of listeners) listener(host);
  };
  const dispose = runtime.dispose.bind(runtime);
  runtime.dispose = async () => {
    const shutdownState = getRuntimeLocalSubagentShutdown(runtime);
    const session = runtime.session;
    const sessionDispose = session.dispose;
    let piDisposalStarted = false;
    const observedDispose = () => {
      piDisposalStarted = true;
      sessionDispose.call(session);
    };
    session.dispose = observedDispose;
    let disposeFailed = false;
    let disposeError: unknown;
    try {
      await dispose();
    } catch (error) {
      disposeFailed = true;
      disposeError = error;
      if (!piDisposalStarted) {
        try {
          observedDispose();
        } catch (fallbackError) {
          throw new AggregateError(
            [error, fallbackError],
            'Local runtime shutdown and Pi disposal both failed',
          );
        }
      }
    } finally {
      if (session.dispose === observedDispose) session.dispose = sessionDispose;
    }
    if (disposeFailed) throw disposeError;
    if (shutdownState.failed) throw shutdownState.error;
  };
  const switchSession = runtime.switchSession.bind(runtime);
  runtime.switchSession = async (...args: Parameters<AgentSessionRuntime['switchSession']>) => {
    const result = await switchSession(...args);
    if (!result.cancelled) notifyHostReplacement();
    return result;
  };
  const newSession = runtime.newSession.bind(runtime);
  runtime.newSession = async (...args: Parameters<AgentSessionRuntime['newSession']>) => {
    const result = await newSession(...args);
    if (!result.cancelled) notifyHostReplacement();
    return result;
  };
  const fork = runtime.fork.bind(runtime);
  runtime.fork = async (...args: Parameters<AgentSessionRuntime['fork']>) => {
    const result = await fork(...args);
    if (!result.cancelled) notifyHostReplacement();
    return result;
  };
  const importFromJsonl = runtime.importFromJsonl.bind(runtime);
  runtime.importFromJsonl = async (...args: Parameters<AgentSessionRuntime['importFromJsonl']>) => {
    const result = await importFromJsonl(...args);
    if (!result.cancelled) notifyHostReplacement();
    return result;
  };
  return localRuntime;
}
