import { HOST_WORKERS_SERVICE, RUNTIME_LIFETIME_SERVICE, MODELS_SERVICE, SESSIONS_SERVICE, type ConfiguredFelanExtension, type FelanExtensionAPI } from '@felan-ai/agent-core';
import { createMemoryExtension } from './index.js';
import { acquireSharedLocalMemoryCoordinator } from './local/shared.js';
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
  const shared = acquireSharedLocalMemoryCoordinator({ agentDir: pi.agentDir });
  const attachment = shared.coordinator.attach({ environment, models, scheduling: root && schedulingAvailable,
    ...(root && !schedulingAvailable ? { unavailableReason: 'Dream scheduling is unavailable on this host; captured memory remains readable.' } : {}),
    ...(models.classifier ? { classifier: models.classifier } : {}) });
  let release: (() => void) | undefined;
  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed ??= (async () => {
      try {
        await attachment.detach();
      } finally {
        release?.();
        await shared.release();
      }
    })();
    return closed;
  };
  pi.on('session_shutdown', close);
  try {
    const host = attachment.createSessionHost({ cwd: pi.runtime.cwd, sessionStorageRoot: pi.runtime.storage('session').root });
    release = root && lifetime ? lifetime.register({ busy: () => attachment.busy(),
      settle: mode => attachment.settle(mode), dispose: close }) : undefined;
    createMemoryExtension({ role: root ? 'root' : 'reader', host })(pi);
    if (root) createMemoryControlExtension({ coordinator: attachment, agentDir: pi.agentDir, presentation: createMemoryPresentation(pi, environment) })(pi);
  } catch (error) {
    void close();
    throw error;
  }
}, { serviceRequirements: { required: [MODELS_SERVICE, SESSIONS_SERVICE], optional: [HOST_WORKERS_SERVICE, RUNTIME_LIFETIME_SERVICE] } }) as ConfiguredFelanExtension;

export default extension;
