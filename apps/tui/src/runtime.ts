import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  AGENT_CORE_VERSION,
  HostAgentRuntime,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  bindFelanExtension,
  createAgentCoreSessionRuntimeFactory,
  createAgentSessionRuntime,
  type AgentSessionServices,
  type CreateAgentSessionOptions,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionPackageImporter,
  type ExtensionConfigOverride,
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
  loadLocalExtensionConfigDefinitions,
  resolveBuiltinExtensionPackages,
} from './extensions.js';
import {
  createLocalSettingsManager,
  getFelanSettings,
  getLocalMemoryProcessingEnabled,
  getLocalOutputStyle,
  getLocalToolDisplayMode,
  isBuiltinExtensionEnabled,
  resolveExtensionConfigSettings,
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
import { createLocalMemoryControlExtension } from './memory/control.js';
import { LocalMemoryCoordinator } from './memory/coordinator.js';
import { createGainExtension } from './gain.js';
import { SavingsService, createModelPriceSource } from './savings.js';
import { createHash } from 'node:crypto';

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
  readonly memoryCoordinator?: LocalMemoryCoordinator;
  readonly onSessionModel?: (model: AgentSession['model']) => void;
  readonly extensionConfigOverrides?: readonly ExtensionConfigOverride[];
  readonly model?: CreateAgentSessionOptions['model'];
  readonly thinkingLevel?: CreateAgentSessionOptions['thinkingLevel'];
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
  readonly memoryCoordinator?: LocalMemoryCoordinator;
  readonly extensionConfigOverrides?: readonly ExtensionConfigOverride[];
  readonly model?: CreateAgentSessionOptions['model'];
  readonly thinkingLevel?: CreateAgentSessionOptions['thinkingLevel'];
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
    extensionConfigWarnings: readonly string[];
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
    const extensionPackages = options.extensionPackages
      ?? resolveBuiltinExtensionPackages(felanSettings.builtinExtensions);
    const importExtension = options.importExtension ?? importLocalExtension;
    const extensionConfigSettings = resolveExtensionConfigSettings(
      felanSettings,
      await loadLocalExtensionConfigDefinitions(extensionPackages, importExtension),
    );
    const extensionConfigOverrides = [
      ...extensionConfigSettings.overrides,
      ...(options.extensionConfigOverrides ?? []),
    ];
    const outputStyle = getLocalOutputStyle(
      settingsManager,
      extensionConfigSettings.configs.get('outputStyle') ?? null,
    );
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
    const memoryHost = options.memoryCoordinator?.createSessionHost({
      cwd,
      sessionStorageRoot: runtimeRequest.sessionStorageRoot,
    });
    const skillPaths = options.skillPaths ?? getLocalSkillPaths(cwd, options.homeDir);
    const subagentSettings = options.subagentSettings ?? felanSettings.felanSubagents;
    const appendSystemPrompt = await loadLocalAppendSystemPrompt(options.agentDir);
    const runtime = options.runtimeFactory?.(runtimeRequest)
      ?? new HostAgentRuntime(cwd, runtimeRequest);
    const savings = new SavingsService({
      runtime,
      rootSessionId: runtimeRequest.rootSessionId,
      projectKey: createHash('sha256').update(cwd, 'utf8').digest('hex'),
      priceSource: createModelPriceSource((reference) => {
        const model = options.modelRuntime.getModel(reference.provider, reference.id);
        if (!model) return undefined;
        return {
          model: reference,
          input: model.cost.input,
          output: model.cost.output,
          cacheRead: model.cost.cacheRead,
          cacheWrite: model.cost.cacheWrite,
          ...(model.cost.tiers === undefined ? {} : {
            tiers: model.cost.tiers.map((tier) => ({
              input: tier.input,
              output: tier.output,
              cacheRead: tier.cacheRead,
              cacheWrite: tier.cacheWrite,
              inputTokensAbove: tier.inputTokensAbove,
            })),
          }),
          fingerprint: createHash('sha256').update(JSON.stringify(model.cost), 'utf8').digest('hex'),
        };
      }),
    });
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
      extensionConfigSettings.configs.get('codex'),
    );
    const memoryControlExtension = options.memoryCoordinator === undefined
      ? undefined
      : bindFelanExtension(
        '@felan-ai/felan/memory-control',
        createLocalMemoryControlExtension({
          coordinator: options.memoryCoordinator,
          agentDir: options.agentDir,
        }),
        runtime,
        options.agentDir,
      );
    if (memoryControlExtension && typeof memoryControlExtension !== 'function') {
      memoryControlExtension.hidden = true;
    }
    const host = await LocalSubagentHost.create({
      sessionId: sessionManager.getSessionId(),
      cwd,
      agentDir: options.agentDir,
      ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
      modelRuntime: options.modelRuntime,
      settingsManager,
      ...(modelScope.scopedModels.length === 0
        ? {}
        : { scopedModels: modelScope.scopedModels }),
      extensionPackages,
      importExtension,
      extensionConfigOverrides,
      savings,
      outputStyle,
      skillPaths,
      ...(options.runtimeFactory === undefined ? {} : { runtimeFactory: options.runtimeFactory }),
      ...(subagentSettings === undefined ? {} : { settings: subagentSettings }),
      ...(options.memoryCoordinator === undefined ? {} : {
        memoryHostFactory: ({ cwd: childCwd, sessionStorageRoot }: {
          readonly cwd: string;
          readonly sessionStorageRoot: string;
        }) => options.memoryCoordinator!.createSessionHost({
          cwd: childCwd,
          sessionStorageRoot,
        }),
      }),
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
      extensionConfigWarnings: extensionConfigSettings.warnings,
    });

    return {
      runtime,
      ...(wrapStreamFunction === undefined ? {} : { wrapStreamFunction }),
      extensionPackages,
      extensionConfigOverrides,
      savings,
      importExtension: createLocalExtensionImporter(
        host,
        options.modelRuntime,
        importExtension,
        shutdownHost,
        memoryHost === undefined ? undefined : { role: 'root' as const, host: memoryHost },
        outputStyle,
      ),
      modelRuntime: options.modelRuntime,
      settingsManager,
      skillPaths,
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
      inlineExtensions: [
        dependencyExtension,
        ...(extensionPackages.length === 0 ? [] : [bindFelanExtension(
          '@felan-ai/felan/gain',
          createGainExtension(savings),
          runtime,
          options.agentDir,
          {},
          savings,
        )]),
        createToolActivityExtension(toolActivityState),
        ...(memoryControlExtension === undefined ? [] : [memoryControlExtension]),
      ],
      ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt: [appendSystemPrompt] }),
      ...(modelScope.scopedModels.length === 0 ? {} : { scopedModels: modelScope.scopedModels }),
    };
  });

  return async (request) => {
    const result = await createCoreRuntime(request);
    options.onSessionModel?.(result.session.model);
    const {
      host,
      modelScope,
      shutdownState,
      toolActivityState,
      extensionConfigWarnings,
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
        ...extensionConfigWarnings.map((message) => ({
          type: 'warning' as const,
          message,
        })),
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
  const startupFelanSettings = getFelanSettings(startupSettings);
  const memoryProcessingEnabled = isBuiltinExtensionEnabled(startupFelanSettings, 'memory')
    && getLocalMemoryProcessingEnabled(startupSettings);
  const sessionDir = options.sessionDir ?? startupSettings.getSessionDir() ?? join(agentDir, 'sessions');
  const sessionManager = options.sessionManager
    ?? (options.continueRecent
      ? SessionManager.continueRecent(cwd, sessionDir)
      : SessionManager.create(cwd, sessionDir));
  const ownsMemoryCoordinator = options.memoryCoordinator === undefined;
  const memoryCoordinator = options.memoryCoordinator ?? new LocalMemoryCoordinator({
    agentDir,
    modelRuntime,
    sessionDir,
    enabled: false,
  });
  const createRuntime = createLocalSessionRuntimeFactory({
    agentDir,
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    modelRuntime,
    ...(options.runtimeFactory === undefined ? {} : { runtimeFactory: options.runtimeFactory }),
    ...(options.skillPaths === undefined ? {} : { skillPaths: options.skillPaths }),
    ...(options.subagentSettings === undefined ? {} : { subagentSettings: options.subagentSettings }),
    ...(options.extensionConfigOverrides === undefined ? {} : { extensionConfigOverrides: options.extensionConfigOverrides }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.thinkingLevel === undefined ? {} : { thinkingLevel: options.thinkingLevel }),
    memoryCoordinator,
    onSessionModel: (model) => memoryCoordinator.setSelectedModel(model),
  });
  try {
    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: sessionManager.getCwd(),
      agentDir,
      sessionManager,
    });
    if (ownsMemoryCoordinator) memoryCoordinator.setEnabled(memoryProcessingEnabled);
    return installLocalSubagentLifecycle(runtime, memoryCoordinator);
  } catch (error) {
    await memoryCoordinator.dispose().catch(() => {});
    throw error;
  }
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

function installLocalSubagentLifecycle(
  runtime: AgentSessionRuntime,
  memoryCoordinator?: LocalMemoryCoordinator,
): LocalFelanRuntime {
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
    let memoryDisposeError: unknown;
    try {
      await memoryCoordinator?.dispose();
    } catch (error) {
      memoryDisposeError = error;
    }
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
    if (disposeFailed && memoryDisposeError !== undefined) {
      throw new AggregateError(
        [disposeError, memoryDisposeError],
        'Local runtime and memory shutdown both failed',
      );
    }
    if (disposeFailed) throw disposeError;
    if (memoryDisposeError !== undefined) throw memoryDisposeError;
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
