import { createDaemonSecretStorage } from './credential-storage.js';
import { DaemonConfiguration } from './configuration.js';
import { createRootPreparation } from './project-trust.js';
import { HostSetupManager } from './setup/manager.js';
import { initializeLocalDaemonProcess, type DaemonProcessConfiguration } from './process-bootstrap.js';
import { Type } from 'typebox';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { HOST_RUNTIME_SERVICE, resolveExtensionConfigs, type AgentSessionRuntimeDiagnostic, type HostRuntimeService, type ModelRuntime } from '@felan-ai/agent-core';
import { resolveModelScopeWithDiagnostics } from '@earendil-works/pi-coding-agent';
import { defineServiceProvider } from '@felan-ai/daemon/provider';
import { SESSION_RUNTIME_SERVICE, type SessionEnvironment, type SessionRuntime } from '@felan-ai/daemon/session-runtime';
import { assertAbsolutePath, canonicalPath } from '@felan-ai/daemon/provider';
import { createLocalClassifier } from './classifier.js';
import { createLocalCodemodeExtension } from './codemode.js';
import { resolveConfiguredExtensionPackages } from './extensions.js';
import { loadLocalExtensionConfigDefinitions, loadLocalExtensionConfigDefinitionsByPackage, importLocalExtension } from './extensions.js';
import { createLocalAgentLogger } from '@felan-ai/daemon/provider';
import { getLocalSkillPaths } from './local-resources.js';
import { acquireFelanModelDefaults } from './model-defaults.js';
import { createRuntimeStorageRequest, type RuntimeFactory } from '@felan-ai/daemon/provider';
import { createLocalSettingsManager, getClassifierModelSetting, getDynamicThinkingEnabled, getFelanSettings, getLocalCodemodeMode, resolveExtensionConfigSettings } from './settings.js';
import { loadLocalAppendSystemPrompt } from './system-prompt.js';
import { setupDependencies } from './dependencies.js';
import { createLocalExecutionServices } from './execution-services.js';
import { createLocalProcessAdapter } from './process-adapter.js';
import { COMPACTION_MESSAGE_TYPE, compactionPresentation } from '@felan-ai/ext-session-compaction/view';
import { openHostUrl, prepareLocalInteractionOpen } from './setup-open.js';
import { parsePiExtensionSettings } from './global-settings.js';
import { createLocalModelRuntime } from './local-model-runtime.js';
import { localSessionConfiguration } from './session-configuration.js';
import { parseApprovalExemptTools } from './tool-policy.js';

export function createLocalSessionRuntime(options: {
  readonly runtimeService: HostRuntimeService;
  readonly runtimeFactory?: RuntimeFactory;
  readonly approvalExemptTools?: readonly string[];
  readonly initializeProcess?: typeof initializeLocalDaemonProcess;
}): SessionRuntime {
  let processAgentDir: string | undefined;
  let processConfiguration: Promise<DaemonProcessConfiguration> | undefined;
  const initializeProcess = (agentDir: string) => {
    const directory = resolve(agentDir);
    if (processAgentDir !== undefined && processAgentDir !== directory) throw new Error('The process agent directory is fixed; restart to change it');
    processAgentDir = directory;
    return processConfiguration ??= (options.initializeProcess ?? initializeLocalDaemonProcess)(directory);
  };
  const environments = new WeakSet<SessionEnvironment>();
  const warnings = new WeakMap<SessionEnvironment, readonly AgentSessionRuntimeDiagnostic[]>();
  const modelRuntimes = new WeakSet<ModelRuntime>();
  const toolPolicy = Object.freeze({
    approvalExemptTools: Object.freeze([...(options.approvalExemptTools ?? [])]),
    trustedInlinePaths: Object.freeze(['<inline:@felan-ai/agent-core/runtime-tools>']),
  });
  return {
    toolPolicy,
    createModelRuntime: agentDir => createLocalModelRuntime(agentDir, undefined, initializeProcess),
    secretStorage: createDaemonSecretStorage(),
    async createHostServices(request) {
      const { agentDir, homeDir, runtime, models, assertCurrent } = request;
      return {
        configuration: new DaemonConfiguration({ agentDir, definitions: request.definitions, assertCurrent }),
        prepareRoot: createRootPreparation({ agentDir, homeDir, broker: request.interactions, assertCurrent }),
        setup: new HostSetupManager({ agentDir, runtime, models, assertCurrent, dependencies: setupDependencies,
          open: (value, signal) => openHostUrl(runtime, value, signal),
          refreshModels: async (provider, signal) => {
            const result = await models.refresh({ providers: [provider], signal });
            if (result.aborted || result.errors.size) throw new Error('Model refresh failed.');
            await request.refreshModelAvailability(signal);
          } }),
      };
    },
    processAdapter: createLocalProcessAdapter(),
    openUrl: openHostUrl,
    prepareOpenInteraction: (runtime, request, assertOwnsPath, signal) => prepareLocalInteractionOpen({ runtime, assertOwnsPath }, request, signal),
    bindExtensions: createLocalExecutionServices(),
    projectMessage: (entry, message) => entry.type === 'compaction'
      ? { ...message, customType: COMPACTION_MESSAGE_TYPE, details: { ...compactionPresentation(entry) } } : message,
    async resolveEnvironment(request) {
      assertAbsolutePath(request.cwd); assertAbsolutePath(request.agentDir);
      if (request.sessionDir !== undefined) assertAbsolutePath(request.sessionDir);
      await initializeProcess(request.agentDir);
      const cwd = await canonicalPath(request.cwd);
      if (!(await stat(cwd)).isDirectory()) throw new Error('Session cwd must be a directory');
      const agentDir = await canonicalPath(request.agentDir);
      const settings = createLocalSettingsManager(cwd, agentDir);
      let directory = request.sessionDir;
      const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
      if (directory === undefined) {
        try {
          directory = settings.getSessionDir();
          if (directory !== undefined && (typeof directory !== 'string' || !directory || directory.includes('\0'))) throw new Error('Invalid session directory');
        } catch {
          directory = undefined;
          diagnostics.push({ type: 'warning', message: 'Invalid configured session directory; using the default.' });
        }
      }
      directory = directory?.replace(/^~(?=$|[\\/])/u, request.homeDir ?? homedir());
      const sessionDir = await canonicalPath(directory === undefined ? join(agentDir, 'sessions') : resolve(cwd, directory));
      const sessionStorageBase = await canonicalPath(join(agentDir, 'storage', 'sessions'));
      const agentStorageRoot = await canonicalPath(join(agentDir, 'storage', 'agent'));
      const executionRoot = await canonicalPath(join(agentDir, 'executions'));
      const memoryRoot = await canonicalPath(join(agentDir, 'memory', 'v1'));
      const environment = Object.freeze({ cwd, agentDir, sessionDir, sessionStorageBase, agentStorageRoot,
        writableRoots: Object.freeze([...new Set([sessionDir, sessionStorageBase, agentStorageRoot, executionRoot, memoryRoot])]),
        workerRoots: Object.freeze([memoryRoot, agentStorageRoot, sessionStorageBase]) });
      environments.add(environment); warnings.set(environment, diagnostics);
      return environment;
    },
    configuration: loadLocalExtensionConfigDefinitions,
    async validateConfiguration(environment, allowedPackages, overrides) {
      if (!environments.has(environment)) throw new Error('Session environment was not resolved by this runtime.');
      const settings = createLocalSettingsManager(environment.cwd, environment.agentDir);
      const packages = resolveConfiguredExtensionPackages(allowedPackages, getFelanSettings(settings).builtinExtensions);
      const definitions = await loadLocalExtensionConfigDefinitions(packages);
      const configured = resolveExtensionConfigSettings(getFelanSettings(settings), definitions);
      resolveExtensionConfigs(definitions, [...configured.overrides, ...overrides]);
    },
    async prepare(request) {
      const { environment, modelRuntime: models } = request;
      const initialized = await processConfiguration!;
      if (!environments.has(environment)) throw new Error('Session environment was not resolved by this runtime.');
      if (modelRuntimes.has(models)) throw new Error('Each session requires its own model registration state.');
      modelRuntimes.add(models);
      const settings = createLocalSettingsManager(environment.cwd, environment.agentDir);
      const packages = resolveConfiguredExtensionPackages(request.extensionPackages, getFelanSettings(settings).builtinExtensions);
      const definitionsByPackage = await loadLocalExtensionConfigDefinitionsByPackage(packages);
      const definitions = [...definitionsByPackage.values()];
      const config = resolveExtensionConfigSettings(getFelanSettings(settings), definitions);
      const overrides = [...config.overrides, ...request.extensionConfigOverrides];
      const extensionConfigs = resolveExtensionConfigs(definitions, overrides);
      const scope = settings.getEnabledModels();
      const modelScope = scope?.length ? await resolveModelScopeWithDiagnostics(scope, models) : { scopedModels: [], diagnostics: [] };
      const runtimeRequest = createRuntimeStorageRequest(environment.cwd, environment.agentDir, request.session.root);
      const paths = await Promise.all(request.extensionPaths.map(async path => { assertAbsolutePath(path); return realpath(path); }));
      if (request.session.parent === undefined && parsePiExtensionSettings(getFelanSettings(settings).piExtensions).llamaCpp) {
        const provider = fileURLToPath(new URL('./extensions/llama/provider.js', import.meta.resolve('@earendil-works/pi-coding-agent')));
        if (!(await stat(provider)).isFile()) throw new Error('The installed Pi llama.cpp provider is unavailable.');
        paths.push(fileURLToPath(import.meta.resolve('@felan-ai/felan/internal/llama/extension')));
      }
      const skills = getLocalSkillPaths(environment.cwd);
      const append = await loadLocalAppendSystemPrompt(environment.agentDir);
      const configuration = localSessionConfiguration({ settings, packages, definitions, configs: extensionConfigs,
        models: modelScope.scopedModels.map(row => ({ provider: row.model.provider, id: row.model.id })), paths, skills, append });
      if (request.configuration !== undefined && !isDeepStrictEqual(request.configuration, configuration)) {
        throw Object.assign(new Error('Local execution settings changed; explicit session reload is required.'), { code: 'configuration_recovery_required' });
      }
      await Promise.all([mkdir(runtimeRequest.sessionStorageRoot, { recursive: true, mode: 0o700 }), mkdir(runtimeRequest.agentStorageRoot, { recursive: true, mode: 0o700 })]);
      const classifier = options.runtimeFactory === undefined ? await createLocalClassifier(models, getClassifierModelSetting(settings)) : { warnings: [] };
      const runtime = options.runtimeFactory?.(runtimeRequest) ?? options.runtimeService.create(environment.cwd, {
        sessionStorageRoot: runtimeRequest.sessionStorageRoot, agentStorageRoot: runtimeRequest.agentStorageRoot,
        agentDir: environment.agentDir, pathAccess: 'host',
        logger: request.logger ?? createLocalAgentLogger(runtimeRequest.agentStorageRoot),
        ...('classifier' in classifier && classifier.classifier ? { classifier: classifier.classifier } : {}),
      });
      const dynamicThinking = request.thinkingLevel === undefined && getDynamicThinkingEnabled(settings);
      const codemode = createLocalCodemodeExtension(getLocalCodemodeMode(settings));
      const release = await acquireFelanModelDefaults();
      let disposed = false;
      return {
        configuration,
        toolPolicy: { ...toolPolicy, trustedInlinePaths: [...toolPolicy.trustedInlinePaths,
          ...packages.map(name => `<inline:${name}>`), ...(codemode ? [`<inline:${codemode.name}>`] : [])] },
        options: { runtime, modelRuntime: models, settingsManager: settings, extensionPackages: packages,
          importExtension: importLocalExtension, extensionConfigOverrides: overrides,
          ...(paths.length ? { extensionPaths: paths } : {}),
          inlineExtensions: codemode ? [codemode] : [], skillPaths: skills, themePaths: [],
          ...(append ? { appendSystemPrompt: [append] } : {}),
          ...(modelScope.scopedModels.length ? { scopedModels: modelScope.scopedModels } : {}),
          ...(request.model ? { model: request.model } : {}),
          ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : dynamicThinking ? { dynamicThinking: true } : {}),
        }, extensionConfigs,
        diagnostics: [...initialized.diagnostics, ...initialized.assertConfiguration(settings.getGlobalSettings()), ...(warnings.get(environment) ?? []),
          ...modelScope.diagnostics, ...[...config.warnings, ...classifier.warnings].map(message => ({ type: 'warning' as const, message }))],
        async dispose() { if (!disposed) { disposed = true; release(); } },
      };
    },
  };
}

export default defineServiceProvider({
  provides: [SESSION_RUNTIME_SERVICE], requires: [HOST_RUNTIME_SERVICE],
  optionsSchema: Type.Object({ approvalExemptTools: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 256 })) }, { additionalProperties: false }),
  async create(context) {
    const runtime = createLocalSessionRuntime({ runtimeService: context.services.get(HOST_RUNTIME_SERVICE)!,
      approvalExemptTools: parseApprovalExemptTools(context.options) });
    return { implementations: [{ contract: SESSION_RUNTIME_SERVICE, value: runtime }], async dispose() {} };
  },
});
