import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { bindFelanExtension, type AgentSession } from '@felan-ai/agent-core';
import { bindSubagentSession } from '@felan-ai/ext-subagents';
import { createLocalCodexStreamFunctionWrapper } from '../codex.js';
import { createLocalExtensionImporter, importLocalExtension, loadLocalExtensionConfigDefinitions, memoryExtensionPackage } from '../extensions.js';
import { createHerdrExtension } from '../herdr.js';
import { LocalMemoryCoordinator } from '../memory/coordinator.js';
import { createMemoryControlExtension } from '../memory/control.js';
import { SavingsService, createModelPriceSource } from '../savings.js';
import { getBrowserAuthorizationPolicy, getFelanSettings, getLocalOutputStyle, setExtensionConfigValue } from '../settings.js';
import { createSessionExtensionUi } from './extension-ui.js';
import type { InteractionBroker } from './broker.js';
import type { ProfileExtensionContext } from './profile.js';
import type { RegistryOptions, SessionRegistry } from './registry.js';
import { prepareRegistrySubagentHost } from './runtime-bridge.js';

interface RootExecution {
  prepared: Awaited<ReturnType<typeof prepareRegistrySubagentHost>>;
  savings: SavingsService;
  memory?: LocalMemoryCoordinator;
  settle(mode?: 'drain' | 'force'): Promise<void>;
  close(): Promise<void>;
}

export function createDaemonExecutionServices(registry: SessionRegistry, broker: InteractionBroker, options: { homeDir?: string; version: string }): RegistryOptions['services'] {
  const roots = new Map<string, RootExecution>();

  async function createRoot(context: ProfileExtensionContext): Promise<RootExecution> {
    const runtime = context.runtime;
    const settings = getFelanSettings(context.settingsManager);
    const savings = new SavingsService({ runtime, rootSessionId: context.rootSessionId,
      projectKey: createHash('sha256').update(context.resources.cwd).digest('hex'),
      priceSource: createModelPriceSource(reference => {
        const model = context.modelRuntime.getModel(reference.provider, reference.id);
        return model && { model: reference, ...model.cost, fingerprint: createHash('sha256').update(JSON.stringify(model.cost)).digest('hex') };
      }) });
    const memory = context.extensionPackages.includes(memoryExtensionPackage)
      ? new LocalMemoryCoordinator({ agentDir: context.resources.agentDir, modelRuntime: context.modelRuntime, sessionDir: context.resources.sessionDir, enabled: false }) : undefined;
    let prepared: RootExecution['prepared'];
    try {
      prepared = await prepareRegistrySubagentHost(registry, context.rootSessionId, {
        cwd: context.resources.cwd, agentDir: context.resources.agentDir, ...(options.homeDir ? { homeDir: options.homeDir } : {}),
        modelRuntime: context.modelRuntime, settingsManager: context.settingsManager, scopedModels: context.scopedModels,
        extensionPackages: context.extensionPackages, importExtension: importLocalExtension,
        extensionConfigOverrides: context.extensionConfigOverrides, skillPaths: context.skillPaths,
        ...(settings.felanSubagents ? { settings: settings.felanSubagents } : {}),
        outputStyle: getLocalOutputStyle(context.settingsManager, context.extensionConfigs.get('outputStyle') ?? null),
        savings, ...(context.classifier ? { classifier: context.classifier } : {}), dynamicThinking: context.dynamicThinking,
        backgroundBashCoordinator: registry.processes.coordinator(context.rootSessionId, runtime), backgroundBashCoordinatorOwner: false,
      });
    } catch (error) { await memory?.dispose(); throw error; }
    let memoryDisposal: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    const disposeMemory = () => memoryDisposal ??= memory?.dispose() ?? Promise.resolve();
    const root: RootExecution = {
      prepared, savings, ...(memory ? { memory } : {}),
      async settle(mode = 'force') { if (mode === 'drain') await memory?.drain(); else await disposeMemory(); await savings.settle(); },
      close() {
        closing ??= (async () => {
          await prepared.host.shutdown(); await disposeMemory(); await savings.settle();
          if (roots.get(context.rootSessionId) === root) roots.delete(context.rootSessionId);
        })();
        return closing;
      },
    };
    roots.set(context.rootSessionId, root); return root;
  }

  return ({ request, getExecutionPolicy }) => ({ getExecutionPolicy, extensions: {
    configuration: packages => loadLocalExtensionConfigDefinitions(packages),
    bind: async context => {
      const sessionId = context.sessionManager.getSessionId();
      const isRoot = request.parentSessionId === undefined;
      const ui = createSessionExtensionUi({ broker, scope: { kind: 'session', session: sessionId, root: context.rootSessionId } });
      let root: RootExecution | undefined;
      try {
        if (!isRoot && !roots.has(context.rootSessionId)) await registry.restore(context.rootSessionId);
        root = isRoot ? await createRoot(context) : roots.get(context.rootSessionId);
        if (!root) throw new Error('Root execution services are unavailable.');
        const activeRoot = root;
        const host = isRoot ? root.prepared.host : request.subagentHost ?? root.prepared.host.scopeToSession(sessionId);
        const browserOverride = [...(request.extensionConfigOverrides ?? [])].reverse().find(row => row.extensionId === 'browser' && Object.hasOwn(row.values, 'authorizationPolicy'))?.values.authorizationPolicy;
        const browserPolicy = { get: () => browserOverride as ReturnType<typeof getBrowserAuthorizationPolicy> ?? getBrowserAuthorizationPolicy(context.settingsManager),
          persist: async (policy: ReturnType<typeof getBrowserAuthorizationPolicy>) => {
            if (browserOverride !== undefined) throw new Error('Browser policy is overridden for this session.');
            registry.options.owner.assertCurrent(); await setExtensionConfigValue(context.resources.agentDir, 'browser', 'authorizationPolicy', policy);
            registry.options.owner.assertCurrent(); await context.settingsManager.reload();
          } };
        const memoryHost = root.memory?.createSessionHost({ cwd: context.resources.cwd, sessionStorageRoot: context.runtime.storage('session').root });
        const memoryControl = isRoot && root.memory ? bindFelanExtension('@felan-ai/daemon/memory-control', createMemoryControlExtension({
          coordinator: root.memory, agentDir: context.resources.agentDir, presentation: ui.memory,
        }), context.runtime, context.resources.agentDir) : undefined;
        const wrapStreamFunction = await createLocalCodexStreamFunctionWrapper(context.extensionPackages, context.runtime, context.resources.agentDir, context.extensionConfigs.get('codex'));
        return {
          uiContext: ui.context,
          savings: root.savings,
          ...(wrapStreamFunction ? { wrapStreamFunction } : {}),
          inlineExtensions: [broker.approvalExtension(registry), createHerdrExtension({ activity: {
            hasPendingWork: () => host.hasPendingWork(), subscribe: listener => host.subscribe(() => listener()),
          } }), ...(memoryControl ? [memoryControl] : [])],
          importExtension: createLocalExtensionImporter(host, context.modelRuntime, importLocalExtension,
            isRoot ? () => host.shutdown() : undefined,
            memoryHost ? { role: isRoot ? 'root' : 'reader', host: memoryHost } : undefined,
            getLocalOutputStyle(context.settingsManager, context.extensionConfigs.get('outputStyle') ?? null), root.savings, context.resources.sessionDir,
            registry.processes.coordinator(context.rootSessionId, context.runtime), false, browserPolicy,
            join(context.resources.agentStorageRoot, 'subscription-usage.json'), context.resources.agentDir, options.version,
            { ...ui, askUser: broker.askUserHost() }),
          onSession: async (session: AgentSession) => {
            if (isRoot) {
              activeRoot.prepared.bind();
              activeRoot.memory?.setModelSelection(session.model, context.scopedModels.length ? context.scopedModels.map(row => row.model) : undefined, context.classifier);
              activeRoot.memory?.setEnabled(true);
              registry.registerService(sessionId, { disposeWhenIdle: true,
                busy: () => !!activeRoot.memory?.hasActiveWork() || activeRoot.savings.hasPendingWork(),
                settle: mode => activeRoot.settle(mode), dispose: () => activeRoot.close() });
            } else bindSubagentSession({ host, session });
            ui.activate(value => registry.projection(sessionId).setPresentation(value));
          },
          dispose: async () => { if (isRoot) await activeRoot.close(); },
          disposeUi: () => ui.dispose(),
        };
      } catch (error) {
        ui.dispose(); if (isRoot && root) await root.close(); throw error;
      }
    },
  } });
}
