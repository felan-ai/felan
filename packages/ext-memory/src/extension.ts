import { HOST_WORKERS_SERVICE, RUNTIME_LIFETIME_SERVICE, MODELS_SERVICE, SESSIONS_SERVICE, type ConfiguredFelanExtension, type FelanExtensionAPI } from '@felan-ai/agent-core';
import { createMemoryExtension } from './index.js';
import { LocalMemoryCoordinator } from './local/coordinator.js';
import { createMemoryControlExtension } from './local/control.js';
import { createMemoryPresentation } from './local/ui.js';
export * from './index.js';

const extension = Object.assign((pi: FelanExtensionAPI) => {
  if (!pi.runtime.files) {
    const message = 'Memory is unavailable because this host does not provide runtime files.';
    createMemoryExtension({ role: 'reader', host: {
      async readCurrent() { throw new Error(message); },
      async recordCheckpoint() { throw new Error(message); },
      async status() { return { enabled: false, state: 'disabled', pendingCheckpoints: 0, message }; },
    } })(pi);
    pi.registerCommand('memory', { description: 'Inspect memory availability', handler: async () => { await pi.ui.notify({ text: message, level: 'warning' }); } });
    return;
  }
  const models = pi.services.get(MODELS_SERVICE)!;
  const sessions = pi.services.get(SESSIONS_SERVICE)!;
  const openWorker = pi.services.get(HOST_WORKERS_SERVICE);
  const lifetime = pi.services.get(RUNTIME_LIFETIME_SERVICE);
  const environment = { runtime: pi.runtime, sessions, ...(openWorker ? { openWorker } : {}) };
  const root = sessions.current.id === sessions.current.root;
  const schedulingAvailable = !!openWorker && !!lifetime;
  const coordinator = new LocalMemoryCoordinator(environment, { agentDir: pi.agentDir, models, enabled: root && schedulingAvailable,
    ...(root && !schedulingAvailable ? { unavailableReason: 'Dream scheduling is unavailable on this host; captured memory remains readable.' } : {}),
    ...(models.classifier ? { classifier: models.classifier } : {}) });
  const host = coordinator.createSessionHost({ cwd: pi.runtime.cwd, sessionStorageRoot: pi.runtime.storage('session').root });
  const release = root && lifetime ? lifetime.register({ busy: () => coordinator.hasActiveWork(),
    settle: mode => mode === 'drain' ? coordinator.drain() : coordinator.dispose(), dispose: () => coordinator.dispose() }) : undefined;
  createMemoryExtension({ role: root ? 'root' : 'reader', host })(pi);
  if (root) createMemoryControlExtension({ coordinator, agentDir: pi.agentDir, presentation: createMemoryPresentation(pi, environment) })(pi);
  pi.on('session_shutdown', async () => { await coordinator.dispose(); release?.(); });
}, { serviceRequirements: { required: [MODELS_SERVICE, SESSIONS_SERVICE], optional: [HOST_WORKERS_SERVICE, RUNTIME_LIFETIME_SERVICE] } }) as ConfiguredFelanExtension;

export default extension;
