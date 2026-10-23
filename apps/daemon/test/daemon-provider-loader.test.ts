import { Type } from 'typebox';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { defineServiceContract, type AgentRuntime, type ModelReference, type ModelRuntime } from '@felan-ai/agent-core';
import { parseSchema } from '@felan-ai/session-protocol';
import { HostConfigSchema, type HostConfig } from '../src/daemon/host-config.js';
import { createConfiguredProviders, ProviderStartupError } from '../src/daemon/provider-loader.js';
import { defineServiceProvider, type ProviderCreateContext, type ProviderSessionContext, type ProviderSessionScope, type ServiceProviderDefinition, type ServiceProviderInstance } from '../src/daemon/provider.js';

const manager = { packageName: '@felan-ai/test-manager', version: '1.0.0', resolveFrom: 'file:///trusted/manager/entry.js' };
const contractA = defineServiceContract<{ value(): string }>('example.a', 1);
const contractB = defineServiceContract<{ value(): string }>('example.b', 1);
const contractC = defineServiceContract<{ value(): string }>('example.c', 1);
const contractD = defineServiceContract<{ value(): string }>('example.d', 1);
const contractE = defineServiceContract<{ value(): string }>('example.e', 1);
const providers = new Map<string, ServiceProviderDefinition>();

afterEach(() => providers.clear());

function config(services: HostConfig['services']): HostConfig {
  return parseSchema(HostConfigSchema, { version: 1, services, extensions: [] });
}

function moduleUrl(specifier: string): string { return `file:///trusted/modules/${specifier.replaceAll('/', '-')}.js`; }

function providerFor(_specifier: string) {
  return async (url: string) => {
    const value = [...providers].find(([name]) => moduleUrl(name) === url)?.[1];
    if (!value) throw new Error(`Unexpected provider import: ${url}`);
    return { default: value };
  };
}

describe('configured service providers', () => {
  it('exposes only declared read-only dependencies to provider factories', async () => {
    providers.set('@test/dependency', defineServiceProvider({ provides: [contractA], async create() {
      return instance(contractA);
    } }));
    let captured: ProviderCreateContext | undefined;
    providers.set('@test/consumer', defineServiceProvider({ provides: [contractB], optional: [contractA], async create(context) {
      captured = context;
      expect(Object.keys(context.services)).toEqual(['get']);
      expect(Object.isFrozen(context.services)).toBe(true);
      expect(context.services.get(contractA)).toBeDefined();
      expect(() => context.services.get(contractB)).toThrow('did not declare');
      expect(context.services).not.toHaveProperty('set');
      expect(context.services).not.toHaveProperty('fork');
      expect(context.services).not.toHaveProperty('revoke');
      return instance(contractB);
    } }));
    const loaded = await loadFake([slot(contractA, '@test/dependency'), slot(contractB, '@test/consumer')]);
    await loaded.dispose();
    expect(() => captured!.services.get(contractA)).toThrow('revoked');
  });

  it('imports only configured package exports and creates providers in dependency order', async () => {
    const order: string[] = [];
    const providerA = defineServiceProvider({ provides: [contractA], optionsSchema: Type.Object({ mode: Type.Literal('safe') }, { additionalProperties: false }),
      async create(context) {
        order.push('a:create');
        expect(context.options).toEqual({ mode: 'safe' });
        return { implementations: [{ contract: contractA, value: { value: () => 'a' } }], dispose: async () => { order.push('a:dispose'); } };
      } });
    const providerB = defineServiceProvider({ provides: [contractB], requires: [{ id: contractA.id, major: contractA.major }],
      async create(context) {
        order.push('b:create');
        expect(context.services.get(contractA)?.value()).toBe('a');
        return { implementations: [{ contract: contractB, value: { value: () => 'b' } }], dispose: async () => { order.push('b:dispose'); } };
      } });
    providers.set('@test/provider-a', providerA); providers.set('@test/provider-b', providerB);
    const imports: string[] = [];
    const loaded = await createConfiguredProviders({ manager, config: config([
      { id: contractB.id, major: contractB.major, use: '@test/provider-b' },
      { id: contractA.id, major: contractA.major, use: '@test/provider-a', options: { mode: 'safe' } },
    ]), resolveSpecifier: specifier => moduleUrl(specifier), importModule: async url => { imports.push(url); return providerFor('')(url); } });
    expect(imports).toEqual([moduleUrl('@test/provider-b'), moduleUrl('@test/provider-a')]);
    expect(order).toEqual(['a:create', 'b:create']);
    expect(loaded.services.get(contractB)?.value()).toBe('b');
    await loaded.dispose();
    expect(order.slice(-2)).toEqual(['b:dispose', 'a:dispose']);
    expect(() => loaded.services.get(contractA)).toThrow('revoked');
  });

  it('rejects missing required slots, unconfigured dependencies, contract mismatch and cycles before execution', async () => {
    const create = vi.fn(async () => ({ implementations: [], dispose: async () => {} }));
    const providerA = defineServiceProvider({ provides: [contractA], requires: [{ id: contractB.id, major: contractB.major }], create });
    const providerB = defineServiceProvider({ provides: [contractB], requires: [{ id: contractA.id, major: contractA.major }], create });
    providers.set('@test/provider-a', providerA); providers.set('@test/provider-b', providerB);
    const cycle = config([{ id: contractA.id, major: 1, use: '@test/provider-a' }, { id: contractB.id, major: 1, use: '@test/provider-b' }]);
    await expect(createConfiguredProviders({ manager, config: cycle, resolveSpecifier: moduleUrl, importModule: providerFor('') })).rejects.toThrow('dependency cycle');
    expect(create).not.toHaveBeenCalled();
    await expect(createConfiguredProviders({ manager, config: config([]), requiredDaemonServices: [contractA.key], resolveSpecifier: moduleUrl })).rejects.toThrow('Required daemon service');
    const mismatch = defineServiceProvider({ provides: [defineServiceContract<{ value(): string }>('example.a', 2)], create });
    providers.set('@test/mismatch', mismatch);
    await expect(createConfiguredProviders({ manager, config: config([{ id: contractA.id, major: 1, use: '@test/mismatch' }]), resolveSpecifier: moduleUrl, importModule: providerFor('') })).rejects.toThrow('declarations do not match');
    expect(create).not.toHaveBeenCalled();
  });

  it('does not import provider modules that host.json does not name', async () => {
    const importModule = vi.fn(providerFor(''));
    const loaded = await createConfiguredProviders({ manager, config: config([]), resolveSpecifier: moduleUrl, importModule });
    expect(importModule).not.toHaveBeenCalled();
    await loaded.dispose();
  });

  it('validates provider options before create and cleans prior instances in reverse order after startup failure', async () => {
    const order: string[] = [];
    const providerA = defineServiceProvider({ provides: [contractA], async create() {
      order.push('a:create');
      return { implementations: [{ contract: contractA, value: { value: () => 'a' } }], dispose: async () => { order.push('a:dispose'); } };
    } });
    const providerB = defineServiceProvider({ provides: [contractB], async create() { order.push('b:create'); throw new Error('provider startup failed'); } });
    providers.set('@test/provider-a', providerA); providers.set('@test/provider-b', providerB);
    const invalidOptions = config([{ id: contractA.id, major: 1, use: '@test/provider-a', options: { secret: 'synthetic' } }]);
    await expect(createConfiguredProviders({ manager, config: invalidOptions, resolveSpecifier: moduleUrl, importModule: providerFor('') })).rejects.toThrow('does not accept options');
    await expect(createConfiguredProviders({ manager, config: config([
      { id: contractA.id, major: 1, use: '@test/provider-a' }, { id: contractB.id, major: 1, use: '@test/provider-b' },
    ]), resolveSpecifier: moduleUrl, importModule: providerFor('') })).rejects.toThrow('provider startup failed');
    expect(order).toEqual(['a:create', 'b:create', 'a:dispose']);
  });

  it('shares a multi-contract provider instance only when its configured options agree', async () => {
    const create = vi.fn(async () => ({ implementations: [
      { contract: contractA, value: { value: () => 'a' } }, { contract: contractB, value: { value: () => 'b' } },
    ], dispose: async () => {} }));
    const multi = defineServiceProvider({ provides: [contractA, contractB], optionsSchema: Type.Object({ mode: Type.Literal('safe') }, { additionalProperties: false }), create });
    providers.set('@test/multi', multi);
    await expect(createConfiguredProviders({ manager, config: config([
      { id: contractA.id, major: 1, use: '@test/multi', options: { mode: 'safe' } },
      { id: contractB.id, major: 1, use: '@test/multi', options: { mode: 'fast' } },
    ]), resolveSpecifier: moduleUrl, importModule: providerFor('') })).rejects.toThrow('conflicting options');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('session-scoped service providers', () => {
  it('keeps session context explicit, service forks independent, and startup signals separate from lifetimes', async () => {
    const events: string[] = [];
    const contexts: ProviderSessionContext[] = [];
    let daemonContext!: ProviderCreateContext;
    providers.set('@test/daemon', defineServiceProvider({
      provides: [contractA],
      async create(context) {
        daemonContext = context;
        events.push('daemon:create');
        return instance(contractA, async () => { events.push('daemon:dispose'); }, async mode => { events.push(`daemon:${mode}`); });
      },
    }));
    providers.set('@test/session', defineServiceProvider({
      scope: 'session', provides: [contractB], requires: [contractA],
      optionsSchema: Type.Object({ label: Type.String() }, { additionalProperties: false }),
      async create(context) {
        contexts.push(context);
        expect(context.services.get(contractA)?.value()).toBe(contractA.id);
        expect(context.options).toEqual({ label: 'safe' });
        return instance(contractB, async () => { events.push(`${context.sessionId}:dispose`); },
          async mode => { events.push(`${context.sessionId}:${mode}`); });
      },
    }));
    const startup = new AbortController();
    const loaded = await loadFake([
      slot(contractB, '@test/session', { label: 'safe' }), slot(contractA, '@test/daemon'),
    ], { signal: startup.signal });
    expect(events).toEqual(['daemon:create']);
    expect(contexts).toEqual([]);
    expect(Object.keys(daemonContext).sort()).toEqual(['options', 'services', 'signal']);
    startup.abort();
    expect(daemonContext.signal.aborted).toBe(false);

    const allowed = [{ provider: 'provider', id: 'model', name: 'Model' }];
    const input = sessionInput('first', allowed);
    const caller = new AbortController();
    const first = await loaded.openSession(Object.assign(input, {
      registry: 'not exposed', ownership: 'not exposed', transport: 'not exposed',
      options: { label: 'not trusted' }, services: 'not trusted', signal: caller.signal,
    }), { signal: caller.signal });
    const second = await loaded.openSession(sessionInput('second', []));
    const third = await loaded.openSession(sessionInput('third', undefined));
    expectTypeOf(first).toEqualTypeOf<ProviderSessionScope>();
    expect(Object.keys(contexts[0]!).sort()).toEqual([
      'allowedModels', 'modelRuntime', 'options', 'rootSessionId', 'runtime', 'secretStorage', 'services', 'sessionId', 'signal',
    ]);
    expect(contexts[0]!.runtime).toBe(input.runtime);
    expect(contexts[0]!.modelRuntime).toBe(input.modelRuntime);
    expect(contexts[0]!.secretStorage).toBe(input.secretStorage);
    expect(contexts[0]!.rootSessionId).toBe('root');
    expect(contexts[0]!.allowedModels).toEqual(allowed);
    allowed[0]!.id = 'mutated later';
    expect(contexts[0]!.allowedModels).toEqual([{ provider: 'provider', id: 'model', name: 'Model' }]);
    expect(contexts[1]!.allowedModels).toEqual([]);
    expect(contexts[2]!.allowedModels).toBeUndefined();
    expect(contexts[0]!.options).not.toBe(contexts[1]!.options);
    expect(contexts[0]!.signal).not.toBe(caller.signal);
    expect(contexts[0]!.signal).not.toBe(contexts[1]!.signal);
    caller.abort();
    expect(contexts[0]!.signal.aborted).toBe(false);
    expect(first.services).not.toBe(second.services);
    expect(loaded.services.get(contractB)).toBeUndefined();
    await expect(loaded.dispose()).rejects.toThrow('explicitly disposed');
    expect(daemonContext.signal.aborted).toBe(false);
    await loaded.settle('drain');
    expect(events.slice(-4)).toEqual(['third:drain', 'second:drain', 'first:drain', 'daemon:drain']);
    await expect(loaded.openSession(sessionInput('after-drain'))).rejects.toThrow('shutting down');
    await first.dispose();
    expect(contexts[0]!.signal.aborted).toBe(true);
    expect(contexts[1]!.signal.aborted).toBe(false);
    expect(() => first.services.get(contractB)).toThrow('revoked');
    expect(second.services.get(contractB)).toBeDefined();
    await third.dispose(); await second.dispose(); await loaded.dispose();
    expect(daemonContext.signal.aborted).toBe(true);
  });

  it.each(['requires', 'optional'] as const)('rejects a daemon-to-session %s edge before any factory runs', async edge => {
    const create = vi.fn(async () => instance(contractA));
    providers.set('@test/daemon', defineServiceProvider({ provides: [contractA], [edge]: [contractB], create }));
    providers.set('@test/session', defineServiceProvider({ scope: 'session', provides: [contractB], create }));
    await expect(loadFake([slot(contractA, '@test/daemon'), slot(contractB, '@test/session')]))
      .rejects.toThrow('cannot depend on session service example.b@1');
    expect(create).not.toHaveBeenCalled();
  });

  it('allows absent optional dependencies, but requires daemon slots and validates all session definitions at boot', async () => {
    const create = vi.fn(async () => instance(contractA));
    providers.set('@test/daemon', defineServiceProvider({ provides: [contractA], optional: [contractB], create }));
    const loaded = await loadFake([slot(contractA, '@test/daemon')]);
    await loaded.dispose();
    create.mockClear();
    providers.set('@test/session', defineServiceProvider({
      scope: 'session', provides: [contractB], optionsSchema: Type.Object({ enabled: Type.Boolean() }), create,
    }));
    await expect(loadFake([slot(contractB, '@test/session', { enabled: true })], { requiredDaemonServices: [contractB.key] }))
      .rejects.toThrow('has a session-scoped provider');
    await expect(loadFake([slot(contractA, '@test/daemon'), slot(contractB, '@test/session', { enabled: 'invalid' })]))
      .rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(() => defineServiceProvider({ scope: 'invalid' as never, provides: [contractA], create })).toThrow('declarations are invalid');
  });

  it('preserves explicit null options for both provider scopes', async () => {
    const daemonCreate = vi.fn(async (context: ProviderCreateContext) => {
      expect(context.options).toBeNull(); return instance(contractA);
    });
    const sessionCreate = vi.fn(async (context: ProviderSessionContext) => {
      expect(context.options).toBeNull(); return instance(contractB);
    });
    providers.set('@test/daemon', defineServiceProvider({ provides: [contractA], optionsSchema: Type.Null(), create: daemonCreate }));
    providers.set('@test/session', defineServiceProvider({ scope: 'session', provides: [contractB], optionsSchema: Type.Null(), create: sessionCreate }));
    const loaded = await loadFake([slot(contractA, '@test/daemon', null), slot(contractB, '@test/session', null)]);
    const scope = await loaded.openSession(sessionInput('first'));
    expect(daemonCreate).toHaveBeenCalledOnce(); expect(sessionCreate).toHaveBeenCalledOnce();
    await scope.dispose(); await loaded.dispose();
  });

  it('orders session dependencies and retries settling without rerunning successful hooks', async () => {
    const events: string[] = [];
    let failSettle = true;
    providers.set('@test/daemon', defineServiceProvider({ provides: [contractA], async create() {
      events.push('a:create'); return instance(contractA, async () => { events.push('a:dispose'); });
    } }));
    providers.set('@test/first', defineServiceProvider({ scope: 'session', provides: [contractB], requires: [contractA], async create(context) {
      expect(context.services.get(contractA)).toBeDefined(); events.push('b:create');
      return instance(contractB, async () => { events.push('b:dispose'); }, async mode => {
        events.push(`b:${mode}`); if (failSettle) { failSettle = false; throw new Error('retry settle'); }
      });
    } }));
    providers.set('@test/second', defineServiceProvider({ scope: 'session', provides: [contractC], optional: [contractB], async create(context) {
      expect(context.services.get(contractB)).toBeDefined(); events.push('c:create');
      return instance(contractC, async () => { events.push('c:dispose'); }, async mode => { events.push(`c:${mode}`); });
    } }));
    const loaded = await loadFake([slot(contractC, '@test/second'), slot(contractB, '@test/first'), slot(contractA, '@test/daemon')]);
    expect(events).toEqual(['a:create']);
    const scope = await loaded.openSession(sessionInput('first'));
    expect(events).toEqual(['a:create', 'b:create', 'c:create']);
    await expect(scope.settle('drain')).rejects.toThrow('retry settle');
    await Promise.all([scope.settle('drain'), scope.settle('drain')]);
    expect(events.slice(3)).toEqual(['c:drain', 'b:drain', 'b:drain']);
    await scope.settle('force');
    expect(events.slice(-2)).toEqual(['c:force', 'b:force']);
    await Promise.all([scope.dispose(), scope.dispose()]);
    await loaded.dispose();
    expect(events.slice(-3)).toEqual(['c:dispose', 'b:dispose', 'a:dispose']);
  });

  it('rejects session dependency cycles and invalid session contexts before effects', async () => {
    const create = vi.fn(async () => instance(contractB));
    providers.set('@test/first', defineServiceProvider({ scope: 'session', provides: [contractB], requires: [contractC], create }));
    providers.set('@test/second', defineServiceProvider({ scope: 'session', provides: [contractC], requires: [contractB], create }));
    await expect(loadFake([slot(contractB, '@test/first'), slot(contractC, '@test/second')])).rejects.toThrow('dependency cycle');
    providers.set('@test/first', defineServiceProvider({ scope: 'session', provides: [contractB], create }));
    const loaded = await loadFake([slot(contractB, '@test/first')]);
    await expect(loaded.openSession({ ...sessionInput('first'), sessionId: '' })).rejects.toThrow('context is invalid');
    await expect(loaded.openSession({ ...sessionInput('first'), allowedModels: [null] as never })).rejects.toThrow('model scope is invalid');
    expect(create).not.toHaveBeenCalled();
    await loaded.dispose();
  });

  it('refuses daemon disposal while an explicitly owned failed scope keeps its dependencies alive', async () => {
    const events: string[] = [];
    let rootSignal!: AbortSignal;
    let sessionSignal!: AbortSignal;
    let fail = true;
    providers.set('@test/daemon', defineServiceProvider({ provides: [contractA], async create(context) {
      rootSignal = context.signal;
      return instance(contractA, async () => { events.push('root'); });
    } }));
    providers.set('@test/first', defineServiceProvider({ scope: 'session', provides: [contractB], requires: [contractA], async create(context) {
      sessionSignal = context.signal;
      return instance(contractB, async () => { events.push('first'); });
    } }));
    providers.set('@test/second', defineServiceProvider({ scope: 'session', provides: [contractC], requires: [contractB], async create(context) {
      return instance(contractC, async () => {
        events.push('second'); expect(context.services.get(contractB)).toBeDefined();
        if (fail) { fail = false; throw new Error('retry disposer'); }
      });
    } }));
    providers.set('@test/third', defineServiceProvider({ scope: 'session', provides: [contractD], requires: [contractC], async create() {
      return instance(contractD, async () => { events.push('third'); });
    } }));
    const loaded = await loadFake([slot(contractD, '@test/third'), slot(contractC, '@test/second'), slot(contractB, '@test/first'), slot(contractA, '@test/daemon')]);
    const scope = await loaded.openSession(sessionInput('first'));
    await expect(scope.dispose()).rejects.toThrow('Provider disposal failed');
    expect(events).toEqual(['third', 'second']);
    expect(sessionSignal.aborted).toBe(true);
    expect(scope.services.get(contractB)).toBeDefined();
    await expect(loaded.dispose()).rejects.toThrow('explicitly disposed');
    expect(rootSignal.aborted).toBe(false);
    await scope.dispose();
    expect(events).toEqual(['third', 'second', 'second', 'first']);
    expect(() => scope.services.get(contractB)).toThrow('revoked');
    await loaded.dispose();
    expect(events.at(-1)).toBe('root');
  });

  it('owns a failed open until loader cleanup can retry without redoing successful disposers', async () => {
    const events: string[] = [];
    let failedDisposals = 0;
    let rootSignal!: AbortSignal;
    providers.set('@test/daemon', defineServiceProvider({ provides: [contractA], async create(context) {
      rootSignal = context.signal; return instance(contractA, async () => { events.push('root'); });
    } }));
    providers.set('@test/first', defineServiceProvider({ scope: 'session', provides: [contractB], requires: [contractA], async create() {
      return instance(contractB, async () => { events.push('first'); });
    } }));
    providers.set('@test/second', defineServiceProvider({ scope: 'session', provides: [contractC], requires: [contractA, contractB], async create(context) {
      return instance(contractC, async () => {
        expect(context.services.get(contractA)).toBeDefined(); events.push('second');
        if (++failedDisposals <= 2) throw new Error('still shutting down');
      });
    } }));
    providers.set('@test/third', defineServiceProvider({ scope: 'session', provides: [contractD], requires: [contractC], async create() {
      return instance(contractD, async () => { events.push('third'); });
    } }));
    providers.set('@test/fails', defineServiceProvider({ scope: 'session', provides: [contractE], requires: [contractD], async create() {
      throw new Error('open failed');
    } }));
    const loaded = await loadFake([
      slot(contractE, '@test/fails'), slot(contractD, '@test/third'), slot(contractC, '@test/second'),
      slot(contractB, '@test/first'), slot(contractA, '@test/daemon'),
    ]);
    await expect(loaded.openSession(sessionInput('first'))).rejects.toBeInstanceOf(ProviderStartupError);
    expect(events).toEqual(['third', 'second']);
    await expect(loaded.dispose()).rejects.toThrow('Provider disposal failed');
    expect(events).toEqual(['third', 'second', 'second']);
    expect(rootSignal.aborted).toBe(false);
    expect(loaded.services.get(contractA)).toBeDefined();
    await loaded.dispose();
    expect(events).toEqual(['third', 'second', 'second', 'second', 'first', 'root']);
  });

  it.each(['duplicate', 'extra', 'undefined'] as const)('cleans invalid %s implementations without publishing a partial service', async invalid => {
    const dispose = vi.fn(async () => {});
    const value = { value: () => 'value' };
    providers.set('@test/session', defineServiceProvider({ scope: 'session', provides: [contractB], async create() {
      return { dispose, implementations: invalid === 'duplicate'
        ? [{ contract: contractB, value }, { contract: contractB, value }]
        : invalid === 'extra' ? [{ contract: contractB, value }, { contract: contractC, value }]
        : [{ contract: contractB, value: undefined }] };
    } }));
    const loaded = await loadFake([slot(contractB, '@test/session')]);
    await expect(loaded.openSession(sessionInput('first'))).rejects.toThrow('exactly its declared contracts');
    expect(dispose).toHaveBeenCalledOnce();
    expect(loaded.services.get(contractB)).toBeUndefined();
    await loaded.dispose();
  });

  it('allows unavailable optional contracts and retains provider-owned contributions', async () => {
    const extension = { name: 'provider-extension', factory() {} };
    const busy = vi.fn(() => true);
    const settle = vi.fn(async () => {});
    const dispose = vi.fn(async () => {});
    providers.set('@test/optional', defineServiceProvider({ scope: 'session', provides: [contractB], async create() {
      return { implementations: [], inlineExtensions: [extension], busy, settle, dispose };
    } }));
    const loaded = await loadFake([slot(contractB, '@test/optional')]);
    const scope = await loaded.openSession(sessionInput('first'));
    expect(scope.services.get(contractB)).toBeUndefined();
    expect(scope.inlineExtensions).toEqual([extension]);
    expect(scope.busy()).toBe(true);
    await scope.settle('force'); await scope.settle('force');
    await scope.dispose(); await scope.dispose();
    expect(settle).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce();
    await loaded.dispose();
  });

  it('rejects omitted required contracts before running consumers', async () => {
    const create = vi.fn(async () => instance(contractC));
    providers.set('@test/required', defineServiceProvider({ provides: [contractB], async create() {
      return { implementations: [], async dispose() {} };
    } }));
    providers.set('@test/consumer', defineServiceProvider({ provides: [contractC], requires: [contractB], create }));
    await expect(loadFake([slot(contractB, '@test/required'), slot(contractC, '@test/consumer')])).rejects.toThrow('omitted a required contract');
    expect(create).not.toHaveBeenCalled();
  });

  it('aborts in-flight session startup, waits for its instance, and then disposes it', async () => {
    const started = deferred<void>();
    const pending = deferred<ServiceProviderInstance>();
    const dispose = vi.fn(async () => {});
    let lifetime!: AbortSignal;
    providers.set('@test/session', defineServiceProvider({ scope: 'session', provides: [contractB], async create(context) {
      lifetime = context.signal; started.resolve(); return pending.promise;
    } }));
    const loaded = await loadFake([slot(contractB, '@test/session')]);
    const controller = new AbortController();
    let finished = false;
    const opening = loaded.openSession(sessionInput('first'), { signal: controller.signal });
    void opening.then(() => { finished = true; }, () => { finished = true; });
    await started.promise;
    await expect(loaded.dispose()).rejects.toThrow('explicitly disposed');
    controller.abort();
    await Promise.resolve();
    expect(lifetime.aborted).toBe(true);
    expect(finished).toBe(false);
    pending.resolve(instance(contractB, dispose));
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    expect(dispose).toHaveBeenCalledOnce();
    await loaded.dispose();
  });

  it('observes cancellation before returning an empty opened scope', async () => {
    const loaded = await loadFake([]);
    const controller = new AbortController();
    const opening = loaded.openSession(sessionInput('first'), { signal: controller.signal });
    controller.abort();
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    await loaded.dispose();
  });

  it('serializes disposal behind an in-flight settle hook', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const events: string[] = [];
    let signal!: AbortSignal;
    providers.set('@test/session', defineServiceProvider({ scope: 'session', provides: [contractB], async create(context) {
      signal = context.signal;
      return instance(contractB, async () => { events.push('dispose'); }, async () => {
        events.push('settle'); entered.resolve(); await release.promise;
      });
    } }));
    const loaded = await loadFake([slot(contractB, '@test/session')]);
    const scope = await loaded.openSession(sessionInput('first'));
    const settling = scope.settle('drain');
    await entered.promise;
    const disposing = scope.dispose();
    expect(signal.aborted).toBe(true);
    await Promise.resolve();
    expect(events).toEqual(['settle']);
    release.resolve();
    await Promise.all([settling, disposing]);
    expect(events).toEqual(['settle', 'dispose']);
    await loaded.dispose();
  });

  it('waits for a late daemon instance before finishing aborted startup cleanup', async () => {
    const entered = deferred<void>();
    const release = deferred<ServiceProviderInstance>();
    const dispose = vi.fn(async () => {});
    let signal!: AbortSignal;
    providers.set('@test/daemon', defineServiceProvider({ provides: [contractA], async create(context) {
      signal = context.signal; entered.resolve(); return release.promise;
    } }));
    const controller = new AbortController();
    let finished = false;
    const loading = loadFake([slot(contractA, '@test/daemon')], { signal: controller.signal });
    void loading.then(() => { finished = true; }, () => { finished = true; });
    await entered.promise;
    controller.abort();
    expect(signal.aborted).toBe(true);
    await Promise.resolve();
    expect(finished).toBe(false);
    release.resolve(instance(contractA, dispose));
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects already aborted startup without imports and retains failed boot cleanup for retry', async () => {
    const controller = new AbortController(); controller.abort();
    const importModule = vi.fn();
    await expect(createConfiguredProviders({ manager, config: config([]), signal: controller.signal, importModule }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(importModule).not.toHaveBeenCalled();
    let fail = true;
    const dispose = vi.fn(async () => { if (fail) { fail = false; throw new Error('retry boot cleanup'); } });
    providers.set('@test/first', defineServiceProvider({ provides: [contractA], async create() { return instance(contractA, dispose); } }));
    providers.set('@test/fails', defineServiceProvider({ provides: [contractB], requires: [contractA], async create() { throw new Error('boot failed'); } }));
    let failure: unknown;
    try { await loadFake([slot(contractB, '@test/fails'), slot(contractA, '@test/first')]); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ProviderStartupError);
    await (failure as ProviderStartupError).cleanup();
    await (failure as ProviderStartupError).cleanup();
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});

describe('provider activation', () => {
  it('separates preparation from activation and activates each scope once in forward dependency order', async () => {
    const events: string[] = [];
    for (const [index, contract] of [contractA, contractB, contractC, contractD].entries()) {
      const previous = [contractA, contractB, contractC, contractD][index - 1];
      const declaration = {
        provides: [contract], ...(previous ? { requires: [previous] } : {}),
        async create() {
          events.push(`${contract.id}:create`);
          return { ...instance(contract, async () => { events.push(`${contract.id}:dispose`); }),
            async activate() { events.push(`${contract.id}:activate`); } };
        },
      };
      providers.set(`@test/${index}`, index < 2
        ? defineServiceProvider(declaration)
        : defineServiceProvider({ ...declaration, scope: 'session' }));
    }
    const loaded = await loadFake([
      slot(contractD, '@test/3'), slot(contractC, '@test/2'), slot(contractB, '@test/1'), slot(contractA, '@test/0'),
    ]);
    const scope = await loaded.openSession(sessionInput('first'));
    expect(events).toEqual(['example.a:create', 'example.b:create', 'example.c:create', 'example.d:create']);
    const daemonActivation = loaded.activate();
    expect(loaded.activate()).toBe(daemonActivation);
    await daemonActivation;
    expect(loaded.activate()).toBe(daemonActivation);
    expect(events.slice(4)).toEqual(['example.a:activate', 'example.b:activate']);
    const sessionActivation = scope.activate();
    expect(scope.activate()).toBe(sessionActivation);
    await sessionActivation;
    expect(scope.activate()).toBe(sessionActivation);
    expect(events.slice(4)).toEqual(['example.a:activate', 'example.b:activate', 'example.c:activate', 'example.d:activate']);
    await scope.dispose(); await loaded.dispose();
    expect(events.slice(-4)).toEqual(['example.d:dispose', 'example.c:dispose', 'example.b:dispose', 'example.a:dispose']);
  });

  it.each(['daemon', 'session'] as const)('retains a failed %s activation and retries only failed disposal', async kind => {
    const events: string[] = [];
    const failure = new Error('activation may have had effects');
    let activationFails = true;
    let disposalFails = true;
    for (const [index, contract] of [contractA, contractB, contractC].entries()) {
      const previous = [contractA, contractB, contractC][index - 1];
      const declaration = {
        provides: [contract], ...(previous ? { requires: [previous] } : {}),
        async create() {
          return { ...instance(contract, async () => {
            events.push(`${contract.id}:dispose`);
            if (contract === contractB && disposalFails) { disposalFails = false; throw new Error('retry disposal'); }
          }), async activate() {
            events.push(`${contract.id}:activate`);
            if (contract === contractB && activationFails) throw failure;
          } };
        },
      };
      providers.set(`@test/${index}`, kind === 'session'
        ? defineServiceProvider({ ...declaration, scope: 'session' }) : defineServiceProvider(declaration));
    }
    const slots = [slot(contractC, '@test/2'), slot(contractB, '@test/1'), slot(contractA, '@test/0')];
    const loaded = await loadFake(slots);
    const scope = kind === 'session' ? await loaded.openSession(sessionInput('first')) : loaded;
    const activation = scope.activate();
    expect(scope.activate()).toBe(activation);
    await expect(activation).rejects.toBe(failure);
    activationFails = false;
    expect(scope.activate()).toBe(activation);
    await expect(scope.activate()).rejects.toBe(failure);
    expect(events).toEqual(['example.a:activate', 'example.b:activate']);
    expect(scope.services.get(contractA)).toBeDefined();
    await expect(scope.dispose()).rejects.toThrow('Provider disposal failed');
    expect(events.slice(2)).toEqual(['example.c:dispose', 'example.b:dispose']);
    expect(scope.services.get(contractA)).toBeDefined();
    await scope.dispose();
    expect(events.slice(2)).toEqual(['example.c:dispose', 'example.b:dispose', 'example.b:dispose', 'example.a:dispose']);
    expect(() => scope.services.get(contractA)).toThrow('revoked');
    await expect(scope.activate()).rejects.toThrow();
    const next = kind === 'session' ? await loaded.openSession(sessionInput('second')) : await loadFake(slots);
    await next.activate();
    expect(events.slice(-3)).toEqual(['example.a:activate', 'example.b:activate', 'example.c:activate']);
    await next.dispose(); await loaded.dispose();
  });

  it.each(['daemon', 'session'] as const)('aborts %s activation and waits for the pending hook before reverse cleanup', async kind => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const events: string[] = [];
    let signal!: AbortSignal;
    const first = {
      provides: [contractA], async create(context: ProviderCreateContext) {
        signal = context.signal;
        return { ...instance(contractA, async () => { events.push('a:dispose'); }), async activate() {
          events.push('a:start'); entered.resolve(); await release.promise; events.push('a:finish');
        } };
      },
    };
    const second = {
      provides: [contractB], requires: [contractA], async create() {
        return { ...instance(contractB, async () => { events.push('b:dispose'); }),
          async activate() { events.push('b:activate'); } };
      },
    };
    providers.set('@test/first', kind === 'session' ? defineServiceProvider({ ...first, scope: 'session' }) : defineServiceProvider(first));
    providers.set('@test/second', kind === 'session' ? defineServiceProvider({ ...second, scope: 'session' }) : defineServiceProvider(second));
    const loaded = await loadFake([slot(contractB, '@test/second'), slot(contractA, '@test/first')]);
    const scope = kind === 'session' ? await loaded.openSession(sessionInput('first')) : loaded;
    const activation = scope.activate();
    await entered.promise;
    expect(scope.activate()).toBe(activation);
    const disposal = scope.dispose();
    expect(signal.aborted).toBe(true);
    await Promise.resolve();
    expect(events).toEqual(['a:start']);
    expect(scope.services.get(contractA)).toBeDefined();
    await expect(scope.activate()).rejects.toThrow();
    const cancelled = expect(activation).rejects.toMatchObject({ name: 'AbortError' });
    release.resolve();
    await Promise.all([cancelled, disposal]);
    expect(events).toEqual(['a:start', 'a:finish', 'b:dispose', 'a:dispose']);
    await expect(scope.activate()).rejects.toThrow();
    await loaded.dispose();
  });

  it('does not start a queued activation once disposal has begun', async () => {
    const activate = vi.fn(async () => {});
    const dispose = vi.fn(async () => {});
    providers.set('@test/session', defineServiceProvider({ scope: 'session', provides: [contractA], async create() {
      return { ...instance(contractA, dispose), activate };
    } }));
    const loaded = await loadFake([slot(contractA, '@test/session')]);
    const scope = await loaded.openSession(sessionInput('first'));
    const activation = scope.activate();
    const disposal = scope.dispose();
    await expect(activation).rejects.toMatchObject({ name: 'AbortError' });
    await disposal;
    expect(activate).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    await loaded.dispose();
  });

  it('supports constructors without activation hooks and rejects activation after disposal', async () => {
    providers.set('@test/daemon', defineServiceProvider({ provides: [contractA], async create() { return instance(contractA); } }));
    const loaded = await loadFake([slot(contractA, '@test/daemon')]);
    const scope = await loaded.openSession(sessionInput('first'));
    await loaded.activate(); await scope.activate();
    await scope.dispose();
    await expect(scope.activate()).rejects.toThrow('disposed');
    await loaded.dispose();
    await expect(loaded.activate()).rejects.toThrow('shutting down');
  });

  it.each(['daemon', 'session'] as const)('rejects an invalid %s activation hook and disposes its instance', async kind => {
    const dispose = vi.fn(async () => {});
    const declaration = { provides: [contractA], async create() {
      return { ...instance(contractA, dispose), activate: true as unknown as () => Promise<void> };
    } };
    providers.set('@test/invalid', kind === 'session'
      ? defineServiceProvider({ ...declaration, scope: 'session' }) : defineServiceProvider(declaration));
    if (kind === 'session') {
      const loaded = await loadFake([slot(contractA, '@test/invalid')]);
      await expect(loaded.openSession(sessionInput('first'))).rejects.toThrow('invalid instance');
      await loaded.dispose();
    } else {
      await expect(loadFake([slot(contractA, '@test/invalid')])).rejects.toThrow('invalid instance');
    }
    expect(dispose).toHaveBeenCalledOnce();
  });
});

function sessionInput(sessionId: string, allowedModels: readonly ModelReference[] | undefined = undefined) {
  return { runtime: { cwd: `/${sessionId}` } as AgentRuntime, modelRuntime: {} as ModelRuntime,
    secretStorage: { read: async () => undefined, write: async () => {}, remove: async () => {} },
    sessionId, rootSessionId: 'root', allowedModels };
}

function slot(contract: typeof contractA, use: string, options?: HostConfig['services'][number]['options']): HostConfig['services'][number] {
  return { id: contract.id, major: contract.major, use, ...(options === undefined ? {} : { options }) };
}

function loadFake(services: HostConfig['services'], options: Partial<Pick<Parameters<typeof createConfiguredProviders>[0], 'signal' | 'requiredDaemonServices'>> = {}) {
  return createConfiguredProviders({ manager, config: config(services), resolveSpecifier: moduleUrl, importModule: providerFor(''), ...options });
}

function instance(contract: typeof contractA, dispose = async () => {}, settle?: ServiceProviderInstance['settle']): ServiceProviderInstance {
  return { implementations: [{ contract, value: { value: () => contract.id } }], dispose, ...(settle ? { settle } : {}) };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
