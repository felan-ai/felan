import type { SessionRuntime } from './session-runtime.js';
import type { SessionExecutionPort } from './session-execution.js';
import type { InteractionBroker } from './broker.js';
import type { RegistryOptions, SessionRegistry } from './registry.js';
import { createRegisteredWorkerLauncher } from './worker.js';
import { createSessionExtensionUi } from './extension-ui.js';

export function createDaemonExecutionServices(registry: SessionRegistry, broker: InteractionBroker, composition: SessionRuntime): RegistryOptions['services'] {
  return ({ request, getExecutionPolicy }) => ({ getExecutionPolicy, extensions: {
    configuration: packages => composition.configuration(packages),
    executionPort(context) {
      const current = { id: context.sessionManager.getSessionId(), root: context.rootSessionId,
        ...(request.parentSessionId ? { parent: request.parentSessionId } : {}) };
      const inRoot = (id: string) => {
        registry.options.owner.assertCurrent();
        if (registry.options.store.session(id).root !== current.root) throw new Error('Session belongs to another root.');
      };
      const port: SessionExecutionPort = {
        current, ...(request.providerContext === undefined ? {} : { providerContext: request.providerContext }),
        ui: {
          request: (value, options) => broker.request(value, options?.audience === 'host' ? { kind: 'host' }
            : { kind: 'session', session: current.id, root: current.root }, { ...options,
            ...(options?.audience === 'owner' ? { authority: 'owner' as const } : {}) }),
          canPresent: (value, audience) => broker.canPresent(value, audience === 'host' ? { kind: 'host' }
            : { kind: 'session', session: current.id, root: current.root }, audience === 'owner' ? { authority: 'owner' } : {}),
          subscribeClients: listener => broker.subscribeClients(listener),
        },
        openWorker: createRegisteredWorkerLauncher(registry, current, context.modelRuntime,
          context.settingsManager.getEnabledModels()?.length ? context.scopedModels.map(row => ({ provider: row.model.provider, id: row.model.id })) : undefined),
        ensureRoot: async () => { if (current.id !== current.root) await registry.restore(current.root); },
        assertCurrent: () => registry.options.owner.assertCurrent(),
        assertOwnsPath: path => registry.options.owner.assertOwnsPath(path),
        assertNewWork: id => { inRoot(id); registry.assertNewWork(); registry.assertDispatch(id); },
        assertDispatch: id => { inRoot(id); registry.assertDispatch(id); },
        activatePolicy: () => registry.activatePolicy(current.root),
        session: id => { inRoot(id); return registry.binding(id)?.runtime.session; },
        executions: () => registry.executionHost(current.id),
        configureExecutions: settings => registry.executionHost(current.id).configure(settings),
        attachExecutionParent: parent => registry.executionHost(current.id).attachParent(parent),
        registerService: service => registry.registerService(current.id, service),
        registerUiActions: prepare => registry.registerUiActions(current.id, prepare),
        publish: value => registry.projection(current.id).setPresentation(value),
        fail: error => registry.failExecution(error),
      };
      return port;
    },
    async bind(context, port) {
      if (!port) throw new Error('Session binding requires its execution port.');
      const ui = createSessionExtensionUi({ port: port.ui });
      let release: (() => void) | undefined;
      try {
        const binding = await composition.bindExtensions?.(context, port);
        return { ...binding, importExtension: binding?.importExtension ?? context.importExtension,
          uiContext: ui.context, createExtensionUi: ui.vocabulary.createExtensionUi,
          inlineExtensions: [broker.approvalExtension(registry), ...(binding?.inlineExtensions ?? [])],
          async onSession(session) {
            ui.activate(port.publish);
            release = port.registerUiActions(ui.vocabulary.prepareAction);
            await binding?.onSession?.(session);
          },
          async dispose() { await binding?.dispose(); },
          async disposeUi() {
            await ui.vocabulary.dispose(); release?.(); ui.dispose();
            await binding?.disposeUi?.();
          },
        };
      } catch (error) { ui.dispose(); throw error; }
    },
  } });
}
