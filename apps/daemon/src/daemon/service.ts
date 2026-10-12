import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { HostAgentRuntime, type ModelRuntime } from '@felan-ai/agent-core';
import { encodeFrame, type DaemonIdentity } from '@felan-ai/session-protocol';
import { createLocalModelRuntime } from '../local-resources.js';
import { loadLocalExtensionConfigDefinitions } from '../extensions.js';
import { DAEMON_VERSION } from '../version.js';
import { DaemonAgentLogs } from './agent-logs.js';
import { createRegistryInteractionBroker, type InteractionBroker } from './broker.js';
import { commandError } from './commands.js';
import { DaemonConfiguration } from './configuration.js';
import { DaemonControlStore } from './control-store.js';
import { createDaemonExecutionServices } from './execution-services.js';
import { SESSION_UI_PRESENTERS } from './extension-ui.js';
import { HostLifecycle, type HostAction, type HostMode } from './lifecycle.js';
import { createLocalDaemonProfile, type LocalDaemonProfileOptions } from './local-profile.js';
import { DaemonOperationalLog } from './operational-log.js';
import { acquireDaemonOwnership } from './ownership.js';
import { SessionRegistry, type RegistryOptions } from './registry.js';
import { SessionServer } from './server.js';
import { BoundedDaemonLogs } from './supervisor.js';
import { assertTargetIdentity, resolveDaemonTarget, type DaemonTarget } from './target.js';
import { connectLocalIpc, readControlFrame } from './ipc.js';
import { createRootPreparation } from './project-trust.js';
import { DaemonTuiPreferences } from './tui-preferences.js';
import { HostSetupManager } from '../setup/manager.js';
import { prepareHostInteraction, openHostUrl } from '../setup/open.js';

export async function startDaemonService(target: DaemonTarget, options: {
  createModelRuntime?: (agentDir: string) => Promise<ModelRuntime>;
  initializeProcess?: LocalDaemonProfileOptions['initializeProcess'];
  drainTimeoutMs?: number;
  replacing?: DaemonIdentity;
} = {}) {
  const owner = await acquireForLaunch(target, options.replacing);
  let sink: BoundedDaemonLogs | undefined;
  let store: DaemonControlStore | undefined;
  let profile: Awaited<ReturnType<typeof createLocalDaemonProfile>> | undefined;
  let registry: SessionRegistry | undefined;
  let server: SessionServer | undefined;
  let setup: HostSetupManager | undefined;
  const agentLogs = new DaemonAgentLogs(owner);
  try {
    sink = new BoundedDaemonLogs(owner);
    const log = new DaemonOperationalLog(sink);
    store = new DaemonControlStore(owner);
    const makeModels = options.createModelRuntime ?? createLocalModelRuntime;
    const homeDir = target.kind === 'isolated' ? dirname(owner.target.runtimeDirectory) : undefined;
    profile = await createLocalDaemonProfile({ agentDir: owner.target.agentDir, ...(homeDir ? { homeDir } : {}),
      createModelRuntime: makeModels, ...(options.initializeProcess ? { initializeProcess: options.initializeProcess } : {}), deferActivation: true,
      wrapRuntime: (runtime, request) => registry!.wrapOpeningRuntime(runtime, request.rootSessionId),
      createLogger: root => agentLogs.create(root) });
    const models = await makeModels(owner.target.agentDir);
    const configuration = new DaemonConfiguration({ agentDir: owner.target.agentDir,
      definitions: await loadLocalExtensionConfigDefinitions(), assertCurrent: () => owner.assertCurrent() });
    let services: RegistryOptions['services'];
    registry = new SessionRegistry({ owner, store, profile, services: context => services(context) });
    const liveRegistry = registry; const liveStore = store; const liveProfile = profile; const liveSink = sink;
    const broker = createRegistryInteractionBroker(registry, { presenters: SESSION_UI_PRESENTERS });
    const setupRuntime = new HostAgentRuntime(owner.target.agentDir, { pathAccess: 'host', agentDir: owner.target.agentDir,
      agentStorageRoot: join(owner.target.agentDir, 'storage', 'agent'), sessionStorageRoot: join(owner.target.agentDir, 'storage', 'setup') });
    setup = new HostSetupManager({ agentDir: owner.target.agentDir, runtime: setupRuntime, models,
      assertCurrent: () => owner.assertCurrent(), open: (value, signal) => openHostUrl(setupRuntime, value, signal),
      refreshModels: async signal => { await models.getAvailable(undefined, { signal }); } });
    const liveSetup = setup;
    services = createDaemonExecutionServices(registry, broker, { ...(homeDir ? { homeDir } : {}), version: DAEMON_VERSION });
    const ambiguous = () => liveStore.snapshot().resources.some(resource => resource.kind !== 'child' && ['missing', 'reconciling'].includes(resource.state));
    let finish!: (action: HostAction) => void;
    const stopped = new Promise<HostAction>(resolve => { finish = resolve; });
    let hold: ReturnType<typeof setInterval> | undefined;
    const lifecycle = new HostLifecycle({ target: owner.target, identity: owner.identity, blocked: ambiguous(),
      ...(options.drainTimeoutMs ? { timeoutMs: options.drainTimeoutMs } : {}),
      allowControl() { if (ambiguous()) throw commandError('busy'); },
      beginDrain: () => { liveSetup.beginDrain(); liveRegistry.beginDrain(); },
      settle: async mode => { await Promise.all([liveSetup.drain(), settleDaemonWork(liveRegistry, broker, mode)]); await liveServer.settleCommands(); },
      record: event => log.record(event),
      complete: async action => {
        clearInterval(idleTimer); clearInterval(hold); removeLoss();
        liveServer.sealCommands(); await liveServer.settleCommands();
        await agentLogs.close(); await liveProfile.dispose();
        liveServer.close(); liveStore.close(); liveSink.close(); await owner.release(); finish(action);
      },
    });
    server = new SessionServer({ registry, configuration, models, version: DAEMON_VERSION, broker,
      setup: liveSetup, prepareOpenInteraction: (id, client, signal) => prepareHostInteraction({ runtime: setupRuntime, broker,
        assertCurrent: () => owner.assertCurrent(), assertOwnsPath: path => owner.assertOwnsPath(path) }, id, client, signal),
      preferences: new DaemonTuiPreferences({ agentDir: owner.target.agentDir, assertCurrent: () => owner.assertCurrent() }),
      prepareRoot: createRootPreparation({ agentDir: owner.target.agentDir, homeDir: homeDir ?? homedir(), broker, assertCurrent: () => owner.assertCurrent() }),
      management: { lifecycle, logs: params => log.page(params) },
      setupNeeds: () => ambiguous() ? [{ code: 'process_recovery', message: 'Unverified prior processes block new work. Operator reconciliation is required.' }]
        : models.getAvailableSnapshot().length ? [] : [{ code: 'provider', message: 'Configure a local model provider. A Felan account is not required.' }] });
    const liveServer = server;
    const idleTimer = setInterval(() => {
      if (lifecycle.state !== 'ready') return;
      void liveRegistry.evictIdle().catch(() => lifecycle.block());
    }, 15_000);
    idleTimer.unref();
    const removeLoss = owner.onLost(() => {
      lifecycle.block(); clearInterval(idleTimer);
      liveSetup.beginDrain();
      // An unresolved owner must not vanish and release native claims implicitly.
      hold ??= setInterval(() => {}, 60_000);
      void liveRegistry.settleWriters().catch(() => {});
    });
    await server.start(); log.record('started');
    return { owner, registry: liveRegistry, server: liveServer, lifecycle, stopped,
      async requestStop(action: HostAction = 'stop', mode: HostMode = 'drain') {
        return liveServer.requestManagement({ v: 1, id: requestId(), op: action === 'stop' ? 'host.stop' : 'host.restart',
          params: { expected: owner.identity, confirmed: true, mode } });
      } };
  } catch (error) {
    try {
      server?.close(); await setup?.drain(); await registry?.shutdown(); await profile?.dispose(); await agentLogs.close();
      store?.close(); sink?.close(); await owner.release();
    } catch (cleanup) {
      setInterval(() => {}, 60_000);
      throw new AggregateError([error, cleanup], 'Daemon startup cleanup is blocked; ownership remains held.');
    }
    throw error;
  }
}

export async function settleDaemonWork(registry: Pick<SessionRegistry, 'shutdown' | 'waitForDrain'>, broker: Pick<InteractionBroker, 'drain'>, mode: HostMode): Promise<void> {
  const draining = broker.drain();
  if (mode === 'force') {
    const results = await Promise.allSettled([draining, registry.shutdown({ interrupt: true })]);
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Forced daemon settlement failed.');
  } else {
    await draining; await registry.waitForDrain(); await registry.shutdown();
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
