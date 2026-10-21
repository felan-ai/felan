import type { HostConfiguration } from './host-services.js';
import { realpath } from 'node:fs/promises';
import { AGENT_CORE_VERSION, createAgentCoreSessionRuntimeFactory, createAgentSessionRuntime, getExtensionConfigDefinition, type AgentRuntime, type AgentSession, type ExtensionConfigWriter, type FelanServiceRegistry, type Logger, type ModelRuntime, type RuntimeDependenciesService, type SessionRef, type SessionsService } from '@felan-ai/agent-core';
import { createRuntimeStorageRequest } from '../runtime-factory.js';
import { inheritExecutionPolicy, TrustedToolCatalog } from './execution-policy.js';
import { resolveTarget, assertTargetUnchanged, assertSessionManagerMatches, openSessionManager, createWorkerBinding, restrictActiveTools, assertAbsolutePath, canonicalPath } from './profile-storage.js';
import { interruptProviderScope, type LoadedProviders } from './provider-loader.js';
import type { SessionExtensionBindings, SessionExtensionContext } from './session-execution.js';
import type { ProviderSecretStorage, ProviderWorkerLauncher } from './provider.js';
import type { SessionComposition, SessionRuntime } from './session-runtime.js';
import { SESSION_LIFECYCLE_API_VERSION, type SessionLifecycle, type SessionResources, type SessionBinding } from './session-lifecycle-contracts.js';
import { diagnosticMessage } from './admission.js';

export interface SessionLifecycleOptions {
  readonly configuration: () => HostConfiguration;
  readonly composition: SessionRuntime;
  readonly agentDir: string;
  readonly homeDir?: string;
  readonly extensionPackages: readonly string[];
  readonly createModelRuntime?: (agentDir: string) => Promise<ModelRuntime>;
  readonly secretStorage: ProviderSecretStorage;
  readonly serviceRegistry: FelanServiceRegistry;
  readonly openServiceScope: LoadedProviders['openSession'];
  readonly wrapRuntime?: (runtime: AgentRuntime, request: ReturnType<typeof createRuntimeStorageRequest>) => AgentRuntime;
  readonly createLogger?: (root: string) => Logger;
  readonly sessions?: (current: SessionRef, cwd: string) => SessionsService;
  readonly openWorker?: (current: SessionRef, models: ModelRuntime, allowed: readonly import('@felan-ai/agent-core').ModelReference[] | undefined) => ProviderWorkerLauncher;
  readonly deferActivation?: boolean;
  readonly runtimeDependencies?: RuntimeDependenciesService;
}

export function createSessionLifecycle(options: SessionLifecycleOptions): SessionLifecycle {
  const environments = new WeakSet<SessionResources>();
  const modelRuntimes = new WeakSet<ModelRuntime>();
  const retained = new Set<() => Promise<void>>();
  let disposed = false;
  return {
    apiVersion: SESSION_LIFECYCLE_API_VERSION,
    id: 'kernel',
    async resolveResources(request) {
      if (disposed) throw new Error('Session lifecycle is disposed.');
      const environment = await options.composition.resolveEnvironment({
        ...request, agentDir: options.agentDir,
        ...(options.homeDir ? { homeDir: options.homeDir } : {})
      });
      for (const path of [environment.cwd, environment.agentDir, environment.sessionDir, environment.sessionStorageBase,
      environment.agentStorageRoot, ...environment.writableRoots, ...(environment.workerRoots ?? [])]) {
        assertAbsolutePath(path);
        if (await canonicalPath(path) !== path) throw new Error('Session environment paths must be canonical.');
      }
      if (environment.agentDir !== await canonicalPath(options.agentDir)
        || environment.workerRoots?.some(path => !environment.writableRoots.includes(path))) throw new Error('Invalid session environment ownership.');
      environments.add(environment);
      return environment;
    },
    async validateConfiguration(environment, overrides) {
      if (disposed || !environments.has(environment)) throw new Error('Unknown session environment.');
      await options.composition.validateConfiguration(environment, options.extensionPackages, overrides);
    },
    async openSession(request) {
      if (disposed || !environments.has(request.resources)) throw new Error('Unknown session environment.');
      inheritExecutionPolicy(request.policy);
      const extensionPaths = await Promise.all((request.extensionPaths ?? []).map(async path => { assertAbsolutePath(path); return realpath(path); }));
      const target = await resolveTarget(request);
      if (request.parentSessionId !== undefined && request.rootSessionId === undefined) throw new Error('Child sessions require their root session identity');
      if (request.parentSessionId === undefined && request.rootSessionId !== undefined
        && (target.identity.kind !== 'resume' || request.rootSessionId !== target.identity.sourceSessionId)) throw new Error('A root session must own its storage identity');
      await request.ownership.assertOwned(request.resources, target.identity);
      const owned = await resolveTarget(request); assertTargetUnchanged(target, owned);
      const manager = await openSessionManager(request, owned);
      assertSessionManagerMatches(manager,
        target.identity.kind === 'resume' ? owned.identity.sourceSessionId : request.target.kind === 'new' ? request.target.id : undefined);
      if (request.worker) return createWorkerBinding({ ...request, extensionPaths }, manager, options);
      const id = manager.getSessionId(); const root = request.parentSessionId === undefined ? id : request.rootSessionId!;
      if (!root || root === '.' || root === '..' || root.includes('\0')) throw new Error('Invalid root session identity');
      const identity: SessionRef = { id, root, ...(request.parentSessionId ? { parent: request.parentSessionId } : {}) };
      const models = await (options.createModelRuntime ? options.createModelRuntime(request.resources.agentDir)
        : options.composition.createModelRuntime(request.resources.agentDir));
      if (modelRuntimes.has(models)) throw new Error('Each session requires its own model registration state.');
      modelRuntimes.add(models);
      let composition: SessionComposition | undefined;
      let bindings: SessionExtensionBindings | undefined;
      let scope: Awaited<ReturnType<LoadedProviders['openSession']>> | undefined;
      let agent: AgentSession | undefined;
      let agentRuntime: AgentRuntime | undefined;
      let disposeSession: (() => void | Promise<void>) | undefined;
      let activePackages: readonly string[] = [];
      let activation: Promise<void> | undefined;
      let releaseProviders: (() => void) | undefined;
      let released = false; let disposal: Promise<void> | undefined;
      const done = new Set<string>();
      const phase = async (name: string, action: (() => void | Promise<void>) | undefined) => {
        if (done.has(name)) return; await action?.(); done.add(name);
      };
      const cleanup = (): Promise<void> => {
        if (released) return Promise.resolve();
        disposal ??= (async () => {
          if (scope) interruptProviderScope(scope);
          await activation?.catch(() => { });
          await phase('settle-providers', scope ? () => scope!.settle('force') : undefined);
          await phase('bindings', bindings?.dispose);
          await phase('session', disposeSession ?? (() => agent?.dispose()));
          await phase('ui', bindings?.disposeUi);
          await phase('binding-services', bindings?.services && bindings.services !== scope?.services ? () => bindings!.services!.revoke() : undefined);
          await phase('providers', scope ? () => scope!.dispose() : undefined);
          releaseProviders?.();
          await phase('composition', composition ? () => composition!.dispose() : undefined);
          retained.delete(cleanup); released = true;
        })().catch(error => { disposal = undefined; throw error; });
        return disposal;
      };
      retained.add(cleanup);
      const factory = createAgentCoreSessionRuntimeFactory(async ({ cwd, sessionManager }) => {
        if (sessionManager !== manager || await canonicalPath(cwd) !== request.resources.cwd) throw new Error('Session replacement requires registry admission.');
        assertSessionManagerMatches(manager, id);
        await request.ownership.assertOwned(request.resources, target.identity);
        composition = await options.composition.prepare({
          environment: request.resources, session: identity, modelRuntime: models,
          ...(request.execution ? { execution: request.execution } : {}),
          ...(options.homeDir ? { homeDir: options.homeDir } : {}),
          ...(options.createLogger ? { logger: options.createLogger(createRuntimeStorageRequest(cwd, options.agentDir, root).agentStorageRoot) } : {}),
          extensionPackages: options.extensionPackages, extensionConfigOverrides: request.extensionConfigOverrides ?? [], extensionPaths,
          ...(request.model ? { model: request.model } : {}), ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {})
        });
        const prepared = composition.options;
        if (prepared.extensionPackages.some(name => !options.extensionPackages.includes(name))) throw new Error('Runtime enabled an unconfigured extension.');
        activePackages = prepared.extensionPackages;
        const runtimeRequest = createRuntimeStorageRequest(cwd, options.agentDir, root);
        const runtime = options.wrapRuntime?.(prepared.runtime, runtimeRequest) ?? prepared.runtime; agentRuntime = runtime;
        const allowed = prepared.settingsManager.getEnabledModels()?.length ? (prepared.scopedModels ?? []).map(row => ({ provider: row.model.provider, id: row.model.id })) : undefined;
        const updateExtensionConfig: ExtensionConfigWriter = async (packageName, patch) => {
          if (released || disposal || !activation) throw new Error('Session configuration binding is inactive.');
          await request.ownership.assertOwned(request.resources, target.identity);
          if (!activePackages.includes(packageName)) throw new Error('Extension configuration is unavailable for this package.');
          const imported = await prepared.importExtension(packageName);
          const extension = imported && typeof imported === 'object' ? Reflect.get(imported, 'default') : undefined;
          const definition = typeof extension === 'function' ? getExtensionConfigDefinition(extension) : undefined;
          if (!definition) throw new Error('Extension configuration is unavailable for this package.');
          if (!patch || typeof patch !== 'object' || Array.isArray(patch)
            || Object.getPrototypeOf(patch) !== Object.prototype && Object.getPrototypeOf(patch) !== null) throw new Error('Extension configuration patch must be a plain object.');
          const values: Record<string, unknown> = {};
          for (const field of Reflect.ownKeys(patch)) {
            if (typeof field !== 'string') throw new Error('Unknown extension configuration field.');
            const descriptor = Object.getOwnPropertyDescriptor(patch, field)!;
            if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('Extension configuration fields must be data properties.');
            if (request.extensionConfigOverrides?.some(row => row.extensionId === definition.id && Object.hasOwn(row.values, field))) throw new Error('Session-overridden configuration cannot be persisted.');
            Object.defineProperty(values, field, { value: descriptor.value, enumerable: true });
          }
          if (!Object.keys(values).length) return;
          const configuration = options.configuration();
          if (!(await configuration.get('global')).writable) throw new Error('Global configuration is read-only.');
          if (released || disposal) throw new Error('Session configuration binding is inactive.');
          await request.ownership.assertOwned(request.resources, target.identity);
          configuration.prepare('global', { extensionConfig: { [definition.id]: values } });
          await configuration.set('global', { extensionConfig: { [definition.id]: values } });
          await request.ownership.assertOwned(request.resources, target.identity);
          await prepared.settingsManager.reload();
        };
        const context: SessionExtensionContext = {
          updateExtensionConfig, runtime, modelRuntime: models, settingsManager: prepared.settingsManager, sessionManager: manager,
          resources: request.resources, rootSessionId: root, policy: inheritExecutionPolicy(request.services.getExecutionPolicy()), extensionPackages: prepared.extensionPackages,
          currentRun: () => request.services.currentRun(root),
          ...(request.execution ? { execution: request.execution } : {}),
          extensionConfigs: composition.extensionConfigs, extensionConfigOverrides: prepared.extensionConfigOverrides ?? [],
          scopedModels: prepared.scopedModels ?? [], skillPaths: prepared.skillPaths ?? [], classifier: runtime.classifier, dynamicThinking: prepared.dynamicThinking ?? false,
          services: options.serviceRegistry, importExtension: prepared.importExtension
        };
        const port = request.services.extensions.executionPort?.(context);
        const { services: _services, ...executionContext } = context;
        scope = await options.openServiceScope({
          runtime, modelRuntime: models, secretStorage: options.secretStorage, sessionId: id, rootSessionId: root, allowedModels: allowed,
          ...(port ? { execution: { context: executionContext, port } } : {}),
          ...(options.runtimeDependencies ? { runtimeDependencies: options.runtimeDependencies } : {}),
          ...(options.sessions ? { sessions: options.sessions(identity, cwd) } : {}), ...(options.openWorker ? { openWorker: options.openWorker(identity, models, allowed) } : {})
        });
        bindings = await request.services.extensions.bind({ ...context, services: scope.services }, port);
        const onSession = bindings.onSession;
        bindings = {
          ...bindings, inlineExtensions: [...(bindings.inlineExtensions ?? []), ...scope.inlineExtensions],
          async onSession(session) {
            if (port) releaseProviders = port.registerService({
              disposeWhenIdle: true,
              busy: () => scope!.busy(), settle: mode => scope!.settle(mode ?? 'force'),
              // Providers retain UI until the session's shutdown handlers finish.
              async dispose() { }
            });
            await onSession?.(session);
          },
        };
        const paths = [...(prepared.extensionPaths ?? []), ...(bindings.extensionPaths ?? [])];
        for (const path of paths) assertAbsolutePath(path);
        return {
          ...prepared, runtime, modelRuntime: models, importExtension: bindings.importExtension,
          updateExtensionConfig,
          ...(request.parentSessionId === undefined && request.instructions
            ? { appendSystemPrompt: [...(prepared.appendSystemPrompt ?? []), request.instructions] } : {}),
          extensionPaths: [...new Set(paths)], inlineExtensions: [...(prepared.inlineExtensions ?? []), ...(bindings.inlineExtensions ?? [])],
          services: bindings.services ?? scope.services, ...(bindings.savings ? { savings: bindings.savings } : {}),
          ...(bindings.wrapStreamFunction ? { wrapStreamFunction: bindings.wrapStreamFunction } : {}),
          ...(bindings.createExtensionUi ? { createExtensionUi: bindings.createExtensionUi } : {})
        };
      });
      try {
        const runtime = await createAgentSessionRuntime(async creation => {
          const result = await factory(creation); agent = result.session;
          const diagnostics = [...result.diagnostics, { type: 'info' as const, message: `Agent Core version: ${AGENT_CORE_VERSION}` }, ...(composition?.diagnostics ?? []),
          ...result.services.settingsManager.drainErrors().map(({ scope, error }) => ({ type: 'warning' as const, message: `${scope} settings: ${diagnosticMessage(error)}` }))];
          return { ...result, diagnostics };
        }, { cwd: request.resources.cwd, agentDir: request.resources.agentDir, sessionManager: manager });
        disposeSession = runtime.dispose.bind(runtime); runtime.dispose = cleanup;
        const reject = async (): Promise<never> => { throw new Error('Session replacement requires registry admission.'); };
        runtime.newSession = reject; runtime.switchSession = reject; runtime.fork = reject; runtime.importFromJsonl = reject;
        const activate = () => {
          if (released || disposal) return Promise.reject(new Error('Session binding is disposing.'));
          return activation ??= (async () => {
            await scope!.activate(); await bindings?.onSession?.(runtime.session);
            await runtime.session.bindExtensions({ mode: 'print', ...(bindings?.uiContext ? { uiContext: bindings.uiContext } : {}) });
            if (request.allowedTools) restrictActiveTools(runtime.session, request.allowedTools);
          })();
        };
        if (!options.deferActivation) await activate();
        const tools = TrustedToolCatalog.fromSession(runtime.session, composition!.toolPolicy);
        return {
          runtime, agentRuntime: agentRuntime!, sessionId: id, rootSessionId: root,
          ...(options.composition.projectMessage ? { projectMessage: options.composition.projectMessage } : {}),
          ...(request.parentSessionId ? { parentSessionId: request.parentSessionId } : {}), resources: request.resources, diagnostics: runtime.diagnostics,
          tools, toolProvenance: tools.provenance, ...(options.deferActivation ? { activate } : {})
        } satisfies SessionBinding;
      } catch (error) {
        try { await cleanup(); } catch (failure) { throw new AggregateError([error, failure], 'Session setup cleanup failed; resources remain owned.'); }
        throw error;
      }
    },
    async dispose() {
      disposed = true;
      for (const cleanup of [...retained].reverse()) await cleanup();
    },
  };
}
