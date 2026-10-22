import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { HOST_RUNTIME_SERVICE, type ModelRuntime, type RuntimeDependenciesService } from '@felan-ai/agent-core';
import { encodeFrame, type DaemonIdentity } from '@felan-ai/session-protocol';
import { RemoteConnector } from '../remote/connector.js';
import { DAEMON_VERSION } from '../version.js';
import { redact } from '../logger.js';
import { DaemonAgentLogs } from './agent-logs.js';
import { createRegistryInteractionBroker, type InteractionBroker } from './broker.js';
import { DaemonControlStore } from './control-store.js';
import { createDaemonExecutionServices } from './execution-services.js';
import { HostLifecycle, type HostAction, type HostMode } from './lifecycle.js';
import type { SessionLifecycle } from './session-lifecycle-contracts.js';
import { SESSION_RUNTIME_SERVICE } from './session-runtime.js';
import type { HostSetup } from './host-services.js';
import { createSessionLifecycle } from './session-lifecycle.js';
import { DaemonOperationalLog } from './operational-log.js';
import { acquireDaemonOwnership } from './ownership.js';
import { SessionRegistry, type RegistryOptions } from './registry.js';
import { SessionServer } from './server.js';
import { BoundedDaemonLogs } from './supervisor.js';
import { assertTargetIdentity, resolveDaemonTarget, type DaemonTarget } from './target.js';
import { connectLocalIpc, readControlFrame } from './ipc.js';
import { prepareHostInteraction } from '../setup/open.js';
import { loadHostConfig, resolveHostComposition, type HostManager } from './host-config.js';
import { createConfiguredProviders, ProviderStartupError, type LoadedProviders } from './provider-loader.js';
import { createRegistrySessionsService } from './session-services.js';
import { createRegisteredWorkerLauncher } from './worker.js';
import { createRuntimeDependenciesPort } from './runtime-dependencies.js';
import { ShutdownError, shutdownStack, shutdownStep } from './shutdown-error.js';

export async function startDaemonService(target: DaemonTarget, options: {
  createModelRuntime?: (agentDir: string) => Promise<ModelRuntime>;
  drainTimeoutMs?: number;
  replacing?: DaemonIdentity;
  hostConfigPath?: string;
  manager?: HostManager;
} = {}) {
  const owner = await acquireForLaunch(target, options.replacing);
  let sink: BoundedDaemonLogs | undefined;
  let store: DaemonControlStore | undefined;
  let sessionLifecycle: SessionLifecycle | undefined;
  let registry: SessionRegistry | undefined;
  let server: SessionServer | undefined;
  let setup: HostSetup | undefined;
  let connector: RemoteConnector | undefined;
  let providers: LoadedProviders | undefined;
  const agentLogs = new DaemonAgentLogs(owner);
  try {
    sink = new BoundedDaemonLogs(owner);
    const manager = options.manager ?? { packageName: '@felan-ai/daemon', version: DAEMON_VERSION, resolveFrom: new URL('../index.js', import.meta.url).href };
    const hostConfig = await loadHostConfig({ agentDir: owner.target.agentDir, ...(options.hostConfigPath ? { explicitPath: options.hostConfigPath } : {}),
      ...(manager.packagedDefaultPath ? { packagedDefaultPath: manager.packagedDefaultPath } : {}) });
    const loadedProviders = await createConfiguredProviders({ config: hostConfig.config, manager, requiredDaemonServices: [HOST_RUNTIME_SERVICE.key, SESSION_RUNTIME_SERVICE.key] });
    providers = loadedProviders;
    const composition = loadedProviders.composition;
    const log = new DaemonOperationalLog(sink);
    store = new DaemonControlStore(owner);
    await store.ownPersistedRoots();
    const homeDir = target.kind === 'isolated' ? dirname(owner.target.runtimeDirectory) : undefined;
    const sessionRuntime = loadedProviders.services.get(SESSION_RUNTIME_SERVICE)!;
    const modelRuntimes = new WeakSet<ModelRuntime>();
    const makeModels = async (agentDir: string): Promise<ModelRuntime> => {
      const models = await (options.createModelRuntime ? options.createModelRuntime(agentDir) : sessionRuntime.createModelRuntime(agentDir));
      if (modelRuntimes.has(models)) throw new Error('Model runtime factories must return fresh registration state.');
      modelRuntimes.add(models);
      return models;
    };
    let runtimeDependencies: RuntimeDependenciesService | undefined;
    sessionLifecycle = createSessionLifecycle({ composition: sessionRuntime,
      agentDir: owner.target.agentDir, ...(homeDir ? { homeDir } : {}),
      createModelRuntime: makeModels, deferActivation: true, configuration: () => host.configuration,
      secretStorage: sessionRuntime.secretStorage,
      runtimeDependencies: { install: (request, options) => runtimeDependencies ? runtimeDependencies.install(request, options)
        : Promise.resolve({ status: 'unavailable', message: 'Dependency installation is unavailable.' }) },
      serviceRegistry: loadedProviders.services, openServiceScope: loadedProviders.openSession,
      sessions: (current, cwd) => createRegistrySessionsService(registry!, current, cwd),
      openWorker: (current, models, allowed) => createRegisteredWorkerLauncher(registry!, current, models, allowed),
      extensionPackages: hostConfig.config.extensions.map(extension => extension.package),
      wrapRuntime: (runtime, request) => registry!.wrapOpeningRuntime(runtime, request.rootSessionId),
      createLogger: root => agentLogs.create(root) });
    const models = await makeModels(owner.target.agentDir);
    let services: RegistryOptions['services'];
    registry = new SessionRegistry({ owner, store, lifecycle: sessionLifecycle, services: context => services(context),
      onDiagnostic: event => log.failure(event),
      ...(sessionRuntime.acquireRun ? { acquireRun: sessionRuntime.acquireRun.bind(sessionRuntime) } : {}),
      onViewCancellationDiagnostic: event => sink!.write('stderr', JSON.stringify({ event: 'view_cancellation', ...event })),
      ...(sessionRuntime.processAdapter ? { processAdapter: sessionRuntime.processAdapter } : {}) });
    const liveRegistry = registry; const liveStore = store; const liveSessionLifecycle = sessionLifecycle; const liveSink = sink;
    const broker = createRegistryInteractionBroker(registry, hostConfig.config.policy ?? {});
    const setupRuntime = loadedProviders.services.get(HOST_RUNTIME_SERVICE)!.create(owner.target.agentDir, { pathAccess: 'host', agentDir: owner.target.agentDir,
      agentStorageRoot: join(owner.target.agentDir, 'storage', 'agent'), sessionStorageRoot: join(owner.target.agentDir, 'storage', 'setup') });
    const host = await sessionRuntime.createHostServices({ agentDir: owner.target.agentDir, homeDir: homeDir ?? homedir(),
      runtime: setupRuntime, models, interactions: { request: broker.request.bind(broker) },
      definitions: await sessionRuntime.configuration(hostConfig.config.extensions.map(row => row.package)),
      refreshModelAvailability: signal => liveRegistry.refreshModelAvailability(signal),
      assertCurrent: () => owner.assertCurrent() });
    setup = host.setup;
    runtimeDependencies = createRuntimeDependenciesPort(setup, broker);
    const liveSetup = setup;
    services = createDaemonExecutionServices(registry, broker, sessionRuntime);
    await loadedProviders.activate();
    let finish!: (action: HostAction) => void;
    const stopped = new Promise<HostAction>(resolve => { finish = resolve; });
    let hold: ReturnType<typeof setInterval> | undefined;
    const warmup = new AbortController(); let warming: Promise<void> = Promise.resolve();
    const lifecycle = new HostLifecycle({ target: owner.target, identity: owner.identity,
      ...(options.drainTimeoutMs ? { timeoutMs: options.drainTimeoutMs } : {}),
      beginDrain: () => { connector?.beginDrain(); liveSetup.beginDrain(); liveRegistry.beginDrain(); },
      endDrain: () => { liveRegistry.endDrain(); liveSetup.endDrain?.(); connector?.endDrain(); },
      canRetry: () => { owner.assertCurrent(); liveStore.assertCurrent(); return !liveRegistry.fenced; },
      onBlocked: (blocked, error) => {
        liveSink.write('stderr', JSON.stringify({ event: 'shutdown_blocked', ...blocked, stack: shutdownStack(error) }));
        log.blocked(blocked);
      },
      settle: async (mode, signal) => {
        const results = await Promise.allSettled([shutdownStep('setup-drain', () => liveSetup.drain()), settleDaemonWork(liveRegistry, broker, mode, signal)]);
        const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (failures.length) throw new AggregateError(failures, 'Daemon settlement failed.');
        signal.throwIfAborted(); await shutdownStep('server-commands', () => liveServer.settleCommands());
        await shutdownStep('providers-settle', () => loadedProviders.settle(mode));
      },
      record: event => log.record(event),
      complete: async action => {
        clearInterval(idleTimer); clearInterval(hold); removeLoss();
        warmup.abort(); await warming;
        await connector?.stop();
        liveServer.sealCommands(); await liveServer.settleCommands();
        await agentLogs.close(); await liveSessionLifecycle.dispose(); await loadedProviders.dispose();
        liveServer.close(); liveStore.close(); liveSink.close(); await owner.release(); finish(action);
      },
    });
    server = new SessionServer({ registry, configuration: host.configuration, models, version: DAEMON_VERSION, broker, composition,
      currentComposition: async () => {
        const currentConfig = await loadHostConfig({ agentDir: owner.target.agentDir,
          ...(options.hostConfigPath ? { explicitPath: options.hostConfigPath } : {}),
          ...(manager.packagedDefaultPath ? { packagedDefaultPath: manager.packagedDefaultPath } : {}) });
        const current = await resolveHostComposition(currentConfig, manager);
        return { managerPackage: current.managerPackage, managerVersion: current.managerVersion,
          providerDigest: current.providerDigest, configDigest: current.configDigest };
      },
      setup: liveSetup, prepareOpenInteraction: (id, client, signal) => prepareHostInteraction({ broker,
        assertCurrent: () => owner.assertCurrent(), prepareOpen: (request, signal) => {
          if (!sessionRuntime.prepareOpenInteraction) throw new Error('Opening this interaction is unsupported.');
          return sessionRuntime.prepareOpenInteraction(setupRuntime, request, path => owner.assertOwnsPath(path), signal);
        } }, id, client, signal),
      ...(host.prepareRoot ? { prepareRoot: host.prepareRoot } : {}),
      management: { lifecycle, logs: params => log.page(params) },
      setupNeeds: () => [...(models.getAvailableSnapshot().length ? [] : [{ code: 'provider', message: 'Configure a local model provider. A Felan account is not required.' }]), ...(connector?.setupNeeds() ?? [])] });
    const liveServer = server;
    try {
      connector = new RemoteConnector({ database: liveStore.database, registry: liveRegistry, server: liveServer, secretStorage: sessionRuntime.secretStorage, owner,
        ...(hostConfig.config.remote ? { remote: hostConfig.config.remote } : {}) });
      liveServer.setRemote(connector);
    } catch { sink.write('stderr', 'Remote connector storage is unavailable; local sessions remain available.'); }
    const idleTimer = setInterval(() => {
      if (lifecycle.state !== 'ready') return;
      void liveRegistry.evictIdle().catch(error => lifecycle.block(error, 'idle-eviction'));
    }, 15_000);
    idleTimer.unref();
    const removeLoss = owner.onLost(error => {
      lifecycle.block(new ShutdownError('ownership-lost', error)); clearInterval(idleTimer); warmup.abort();
      void connector?.stop();
      liveSetup.beginDrain();
      // An unresolved owner must not vanish and release native claims implicitly.
      hold ??= setInterval(() => {}, 60_000);
      void liveRegistry.settleWriters().catch(() => {});
    });
    await server.start(); connector?.start(); log.record('started');
    warming = liveRegistry.warmLegacySessions(warmup.signal).catch(() => { if (!warmup.signal.aborted) log.record('legacy_warmup_failed'); });
    return { owner, registry: liveRegistry, server: liveServer, lifecycle, stopped,
      async requestStop(action: HostAction = 'stop', mode: HostMode = 'drain') {
        return liveServer.requestManagement({ v: 1, id: requestId(), op: action === 'stop' ? 'host.stop' : 'host.restart',
          params: { expected: owner.identity, mode } });
      } };
  } catch (error) {
    sink?.write('stderr', error instanceof Error ? redact(`${error.name}: ${error.message}`) : 'Daemon startup failed.');
    try {
      await connector?.stop(); server?.close(); await setup?.drain(); await registry?.shutdown(); await sessionLifecycle?.dispose(); await providers?.dispose(); await agentLogs.close();
      if (error instanceof ProviderStartupError) await error.cleanup();
      store?.close(); sink?.close(); await owner.release();
    } catch (cleanup) {
      setInterval(() => {}, 60_000);
      throw new AggregateError([error, cleanup], 'Daemon startup cleanup is blocked; ownership remains held.');
    }
    throw error;
  }
}

export async function settleDaemonWork(registry: Pick<SessionRegistry, 'shutdown' | 'waitForDrain'>, broker: Pick<InteractionBroker, 'drain'>, mode: HostMode, signal?: AbortSignal): Promise<void> {
  const draining = shutdownStep('broker-drain', () => broker.drain());
  if (mode === 'force') {
    const results = await Promise.allSettled([draining, registry.shutdown({ interrupt: true })]);
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Forced daemon settlement failed.');
  } else {
    await draining; await shutdownStep('drain-wait', () => registry.waitForDrain(signal)); signal?.throwIfAborted(); await registry.shutdown();
  }
}

async function acquireForLaunch(target: DaemonTarget, replacing?: DaemonIdentity) {
  const resolved = resolveDaemonTarget(target);
  if (replacing) assertTargetIdentity(resolved, replacing, replacing);
  const deadline = performance.now() + 8_000;
  for (;;) {
    try { return await acquireDaemonOwnership(target); }
    catch (error) {
      if (!replacing || (error as { code?: string }).code !== 'owner_running' || performance.now() >= deadline) throw error;
      try {
        const socket = await connectLocalIpc(resolved);
        try {
          const id = randomUUID(); const pending = readControlFrame(socket, Math.min(500, deadline - performance.now()));
          socket.write(encodeFrame({ control: 1, id, op: 'host.status', params: { expected: replacing } }));
          const response = await pending;
          assertTargetIdentity(resolved, replacing, response.identity);
          if (response.re !== id || response.outcome !== 'accepted' || !['draining', 'stopped'].includes(response.state)) throw error;
        } finally { socket.destroy(); }
      } catch (probe) {
        if (!['ENOENT', 'stale_endpoint', 'unavailable'].includes((probe as { code?: string }).code ?? '')) throw probe;
      }
      await delay(Math.min(25, Math.max(0, deadline - performance.now())));
    }
  }
}

function requestId(): string {
  const bytes = randomBytes(16); bytes.writeUIntBE(Date.now(), 0, 6); bytes[6] = (bytes[6]! & 15) | 0x70; bytes[8] = (bytes[8]! & 63) | 0x80;
  const hex = bytes.toString('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
