import { createExtensionServiceAccess, createFelanServiceRegistry, defineServiceContract, type FelanServiceRegistry } from '@felan-ai/agent-core';
import { parseSchema, type JsonValue } from '@felan-ai/session-protocol';
import { resolveHostComposition, type HostComposition, type HostConfig } from './host-config.js';
import {
  defineServiceProvider,
  type ProviderCreateContext,
  type ProviderSessionContext,
  type ProviderSessionScope,
  type ServiceProviderDefinition,
  type ServiceProviderInstance,
} from './provider.js';

export interface LoadedProviders {
  readonly services: FelanServiceRegistry;
  readonly composition: HostComposition;
  activate(): Promise<void>;
  openSession(
    context: Omit<ProviderSessionContext, 'services' | 'options' | 'signal'>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ProviderSessionScope>;
  settle(mode: 'drain' | 'force'): Promise<void>;
  dispose(): Promise<void>;
}

/** Retains a cleanup retry when startup cannot return its owner. */
export class ProviderStartupError extends AggregateError {
  constructor(error: unknown, cleanupError: unknown, readonly cleanup: () => Promise<void>) {
    super([error, cleanupError], 'Provider startup failed and cleanup is blocked.');
    this.name = 'ProviderStartupError';
  }
}

export async function createConfiguredProviders(options: {
  readonly config: HostConfig;
  readonly manager: Parameters<typeof resolveHostComposition>[1];
  readonly requiredDaemonServices?: readonly string[];
  readonly signal?: AbortSignal;
  readonly importModule?: (moduleUrl: string) => Promise<unknown>;
  readonly resolveSpecifier?: (specifier: string, resolveFrom: string) => string;
}): Promise<LoadedProviders> {
  checkStartup(options.signal);
  const composition = await resolveHostComposition({ config: options.config, source: { kind: 'agent-directory', path: '' }, digest: '' }, options.manager, options.resolveSpecifier);
  checkStartup(options.signal);
  const configuredByKey = new Map(options.config.services.map(service => [`${service.id}@${service.major}`, service]));
  if (configuredByKey.size !== options.config.services.length) throw new Error('A service has more than one configured provider.');
  for (const required of options.requiredDaemonServices ?? []) if (!configuredByKey.has(required)) {
    throw new Error(`Required daemon service ${required} has no configured provider.`);
  }

  const modules = new Map<string, ServiceProviderDefinition>();
  const moduleOptions = new Map<string, JsonValue | undefined>();
  const importer = options.importModule ?? (specifier => import(specifier));
  for (const moduleUrl of new Set(composition.providers.map(provider => provider.moduleUrl))) {
    checkStartup(options.signal);
    const imported = await importer(moduleUrl);
    checkStartup(options.signal);
    const candidate = imported && typeof imported === 'object' && 'default' in imported ? imported.default : undefined;
    if (!candidate || typeof candidate !== 'object') throw new Error(`Configured provider ${moduleUrl} must default-export a service provider.`);
    const definition = defineServiceProvider(candidate as ServiceProviderDefinition);
    modules.set(moduleUrl, definition);
  }

  const providerFor = new Map<string, string>();
  for (const provider of composition.providers) providerFor.set(`${provider.id}@${provider.major}`, provider.moduleUrl);
  for (const required of options.requiredDaemonServices ?? []) {
    if (modules.get(providerFor.get(required)!)?.scope === 'session') {
      throw new Error(`Required daemon service ${required} has a session-scoped provider.`);
    }
  }
  for (const [moduleUrl, definition] of modules) {
    const declared = new Set(definition.provides.map(contract => contract.key));
    const configured = new Set(composition.providers.filter(provider => provider.moduleUrl === moduleUrl).map(provider => `${provider.id}@${provider.major}`));
    if (declared.size !== configured.size || [...declared].some(key => !configured.has(key))) {
      throw new Error(`Configured provider ${moduleUrl} contract declarations do not match host.json.`);
    }
    const entries = composition.providers.filter(provider => provider.moduleUrl === moduleUrl);
    const optionValues = entries.map(provider => provider.options);
    if (optionValues.some(value => JSON.stringify(value) !== JSON.stringify(optionValues[0]))) {
      throw new Error(`Provider ${moduleUrl} has conflicting options across its configured contracts.`);
    }
    const optionsValue = optionValues[0];
    if (definition.optionsSchema) {
      moduleOptions.set(moduleUrl, parseSchema(definition.optionsSchema, optionsValue === undefined ? {} : optionsValue) as JsonValue);
    } else {
      if (optionsValue !== undefined) throw new Error(`Provider ${moduleUrl} does not accept options.`);
      moduleOptions.set(moduleUrl, undefined);
    }
  }

  const requiredBy = new Map<string, Set<string>>();
  const mandatoryContracts = new Set(options.requiredDaemonServices ?? []);
  for (const [moduleUrl, definition] of modules) {
    const dependencies = new Set<string>();
    for (const contract of definition.requires ?? []) {
      const key = `${contract.id}@${contract.major}`;
      mandatoryContracts.add(key);
      const dependency = providerFor.get(key);
      if (!dependency) throw new Error(`Provider ${moduleUrl} requires unconfigured service ${key}.`);
      if (definition.scope !== 'session' && modules.get(dependency)!.scope === 'session') {
        throw new Error(`Daemon provider ${moduleUrl} cannot depend on session service ${key}.`);
      }
      dependencies.add(dependency);
    }
    for (const contract of definition.optional ?? []) {
      const key = `${contract.id}@${contract.major}`;
      const dependency = providerFor.get(key);
      if (dependency) {
        if (definition.scope !== 'session' && modules.get(dependency)!.scope === 'session') {
          throw new Error(`Daemon provider ${moduleUrl} cannot depend on session service ${key}.`);
        }
        dependencies.add(dependency);
      }
    }
    requiredBy.set(moduleUrl, dependencies);
  }
  const order: string[] = [];
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (moduleUrl: string) => {
    if (visited.has(moduleUrl)) return;
    if (visiting.has(moduleUrl)) throw new Error('Configured service provider dependency cycle.');
    visiting.add(moduleUrl);
    for (const dependency of requiredBy.get(moduleUrl) ?? []) visit(dependency);
    visiting.delete(moduleUrl); visited.add(moduleUrl); order.push(moduleUrl);
  };
  for (const moduleUrl of modules.keys()) visit(moduleUrl);

  async function start(scope: ManagedProviderScope, session: SessionInputs | undefined, startupSignal?: AbortSignal): Promise<void> {
    const relayAbort = () => scope.lifetime.abort();
    if (startupSignal?.aborted) relayAbort();
    startupSignal?.addEventListener('abort', relayAbort, { once: true });
    try {
      for (const moduleUrl of order) {
        const definition = modules.get(moduleUrl)!;
        if ((definition.scope === 'session') !== (session !== undefined)) continue;
        checkStartup(scope.lifetime.signal);
        const context: ProviderCreateContext = Object.freeze({
          services: createExtensionServiceAccess(scope.api.services, {
            required: (definition.requires ?? []).map(contract => defineServiceContract(contract.id, contract.major)),
            optional: (definition.optional ?? []).map(contract => defineServiceContract(contract.id, contract.major)),
          }),
          options: structuredClone(moduleOptions.get(moduleUrl)),
          signal: scope.lifetime.signal,
        });
        const instance = definition.scope === 'session'
          ? await definition.create(Object.freeze({ ...context, ...session! }))
          : await definition.create(context);
        scope.add(moduleUrl, definition, instance, mandatoryContracts);
        checkStartup(scope.lifetime.signal);
      }
      checkStartup(scope.lifetime.signal);
    } finally {
      startupSignal?.removeEventListener('abort', relayAbort);
    }
  }

  const daemon = createProviderScope(createFelanServiceRegistry());
  try {
    await start(daemon, undefined, options.signal);
    checkStartup(options.signal);
  } catch (error) {
    await cleanupFailedStart(daemon.api, error);
  }
  const sessions = new Set<OwnedProviderSession>();
  let closing = false;
  let disposal: Promise<void> | undefined;
  return Object.freeze({
    services: daemon.api.services,
    composition,
    activate() {
      if (closing) return Promise.reject(new Error('Configured providers are shutting down.'));
      return daemon.api.activate();
    },
    async openSession(context: SessionInputs, openOptions?: { readonly signal?: AbortSignal }) {
      if (closing) throw new Error('Configured providers are shutting down.');
      checkStartup(openOptions?.signal);
      const inputs = sessionInputs(context);
      const record: OwnedProviderSession = {
        scope: createProviderScope(daemon.api.services.fork(), () => sessions.delete(record)),
        opening: true,
        failedOpen: false,
      };
      sessions.add(record);
      try {
        await start(record.scope, inputs, openOptions?.signal);
        checkStartup(openOptions?.signal);
        record.opening = false;
        return record.scope.api;
      } catch (error) {
        record.opening = false;
        record.failedOpen = true;
        return cleanupFailedStart(record.scope.api, error);
      }
    },
    async settle(mode: 'drain' | 'force') {
      if ([...sessions].some(record => record.opening)) throw new Error('Session providers are still starting.');
      closing = true;
      for (const record of [...sessions].reverse()) await record.scope.api.settle(mode);
      await daemon.api.settle(mode);
    },
    dispose() {
      if ([...sessions].some(record => !record.failedOpen)) {
        return Promise.reject(new Error('Session provider scopes must be explicitly disposed before daemon providers.'));
      }
      if (!disposal) {
        closing = true;
        disposal = (async () => {
          for (const record of [...sessions].reverse()) await record.scope.api.dispose();
          await daemon.api.dispose();
        })();
        const attempt = disposal;
        void attempt.catch(() => { if (disposal === attempt) disposal = undefined; });
      }
      return disposal;
    },
  });
}

type SessionInputs = Omit<ProviderSessionContext, 'services' | 'options' | 'signal'>;

const scopeLifetimes = new WeakMap<ProviderSessionScope, AbortController>();

export function interruptProviderScope(scope: ProviderSessionScope): void {
  scopeLifetimes.get(scope)?.abort();
}

interface ManagedProviderScope {
  readonly api: ProviderSessionScope;
  readonly lifetime: AbortController;
  add(moduleUrl: string, definition: ServiceProviderDefinition, instance: ServiceProviderInstance, mandatoryContracts: ReadonlySet<string>): void;
}

interface OwnedProviderSession {
  readonly scope: ManagedProviderScope;
  opening: boolean;
  failedOpen: boolean;
}

function createProviderScope(services: FelanServiceRegistry, onDisposed?: () => void): ManagedProviderScope {
  const lifetime = new AbortController();
  const instances: ServiceProviderInstance[] = [];
  const active = new Set<ServiceProviderInstance>();
  const settled = new Map<'drain' | 'force', Set<ServiceProviderInstance>>();
  const settlements = new Map<'drain' | 'force', Promise<void>>();
  let tail = Promise.resolve();
  let activation: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;
  let disposed = false;
  function enqueue(operation: () => Promise<void>): Promise<void> {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  }
  const api: ProviderSessionScope = Object.freeze({
    services,
    get inlineExtensions() { return instances.flatMap(instance => instance.inlineExtensions ?? []); },
    busy() { return [...active].some(instance => instance.busy?.()); },
    activate() {
      if (disposed) return Promise.reject(new Error('Provider scope is disposed.'));
      if (lifetime.signal.aborted) return Promise.reject(new Error('Provider scope is disposing.'));
      activation ??= enqueue(async () => {
        for (const instance of instances) {
          lifetime.signal.throwIfAborted();
          await instance.activate?.();
        }
        lifetime.signal.throwIfAborted();
      });
      return activation;
    },
    settle(mode: 'drain' | 'force') {
      if (disposed) return Promise.resolve();
      if (mode === 'force') lifetime.abort();
      else if (lifetime.signal.aborted) return Promise.reject(new Error('Provider scope is disposing.'));
      let current = settlements.get(mode);
      if (!current) {
        const completed = settled.get(mode) ?? new Set<ServiceProviderInstance>();
        settled.set(mode, completed);
        current = enqueue(async () => {
          for (const instance of [...instances].reverse()) {
            if (!active.has(instance) || completed.has(instance)) continue;
            await instance.settle?.(mode);
            completed.add(instance);
          }
        });
        settlements.set(mode, current);
        const attempt = current;
        void attempt.catch(() => { if (settlements.get(mode) === attempt) settlements.delete(mode); });
      }
      return current;
    },
    dispose() {
      if (disposed) return Promise.resolve();
      lifetime.abort();
      if (!disposal) {
        disposal = enqueue(async () => {
          for (const instance of [...instances].reverse()) {
            if (!active.has(instance)) continue;
            try { await instance.dispose(); } catch (error) {
              throw new AggregateError([error], 'Provider disposal failed.');
            }
            active.delete(instance);
          }
          services.revoke();
          disposed = true;
          onDisposed?.();
        });
        const attempt = disposal;
        void attempt.catch(() => { if (disposal === attempt) disposal = undefined; });
      }
      return disposal;
    },
  });
  scopeLifetimes.set(api, lifetime);
  return {
    api, lifetime,
    add(moduleUrl, definition, instance, mandatoryContracts) {
      if (!instance || typeof instance.dispose !== 'function') throw new Error(`Provider ${moduleUrl} returned an invalid instance.`);
      instances.push(instance);
      active.add(instance);
      if (!Array.isArray(instance.implementations)
        || instance.inlineExtensions !== undefined && !Array.isArray(instance.inlineExtensions)
        || instance.busy !== undefined && typeof instance.busy !== 'function'
        || instance.activate !== undefined && typeof instance.activate !== 'function'
        || instance.settle !== undefined && typeof instance.settle !== 'function') {
        throw new Error(`Provider ${moduleUrl} returned an invalid instance.`);
      }
      const expected = new Set(definition.provides.map(contract => contract.key));
      const actual = new Set<string>();
      for (const row of instance.implementations) {
        const key = row?.contract?.key;
        if (!key || key !== `${row.contract.id}@${row.contract.major}` || !expected.has(key) || actual.has(key) || row.value === undefined) {
          throw new Error(`Provider ${moduleUrl} did not implement exactly its declared contracts.`);
        }
        actual.add(key);
      }
      if ([...expected].some(key => mandatoryContracts.has(key) && !actual.has(key))) throw new Error(`Provider ${moduleUrl} omitted a required contract.`);
      for (const row of instance.implementations) services.set(row.contract, row.value);
    },
  };
}

async function cleanupFailedStart(scope: ProviderSessionScope, error: unknown): Promise<never> {
  try { await scope.dispose(); } catch (cleanupError) {
    throw new ProviderStartupError(error, cleanupError, () => scope.dispose());
  }
  throw error;
}

function checkStartup(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Provider startup was cancelled.', 'AbortError');
}

function sessionInputs(context: SessionInputs): SessionInputs {
  if (!context || !context.runtime || typeof context.runtime !== 'object'
    || !context.modelRuntime || typeof context.modelRuntime !== 'object'
    || !context.secretStorage || typeof context.secretStorage.read !== 'function'
    || typeof context.secretStorage.write !== 'function' || typeof context.secretStorage.remove !== 'function'
    || context.sessions !== undefined && (!context.sessions.current || context.sessions.current.id !== context.sessionId
      || context.sessions.current.root !== context.rootSessionId || typeof context.sessions.history !== 'function'
      || typeof context.sessions.create !== 'function' || typeof context.sessions.setTitleIfMissing !== 'function')
    || context.openWorker !== undefined && typeof context.openWorker !== 'function'
    || context.runtimeDependencies !== undefined && typeof context.runtimeDependencies.install !== 'function'
    || typeof context.sessionId !== 'string' || !context.sessionId.trim()
    || typeof context.rootSessionId !== 'string' || !context.rootSessionId.trim()
    || context.allowedModels !== undefined && !Array.isArray(context.allowedModels)) {
    throw new Error('Provider session context is invalid.');
  }
  const allowedModels = context.allowedModels?.map(reference => {
    if (!reference || typeof reference.provider !== 'string' || !reference.provider.trim()
      || typeof reference.id !== 'string' || !reference.id.trim()
      || reference.name !== undefined && typeof reference.name !== 'string') throw new Error('Provider session model scope is invalid.');
    return Object.freeze({ provider: reference.provider, id: reference.id,
      ...(reference.name === undefined ? {} : { name: reference.name }) });
  });
  return Object.freeze({ ...(context.execution ? { execution: context.execution } : {}), runtime: context.runtime, modelRuntime: context.modelRuntime, secretStorage: context.secretStorage,
    ...(context.sessions ? { sessions: context.sessions } : {}),
    ...(context.openWorker ? { openWorker: context.openWorker } : {}),
    ...(context.runtimeDependencies ? { runtimeDependencies: context.runtimeDependencies } : {}),
    sessionId: context.sessionId, rootSessionId: context.rootSessionId,
    allowedModels: allowedModels === undefined ? undefined : Object.freeze(allowedModels) });
}
