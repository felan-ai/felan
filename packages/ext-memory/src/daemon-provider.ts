import {
  HOST_MAINTENANCE_SERVICE,
  HOST_MODELS_SERVICE,
  HostAgentRuntime,
  type AgentRuntime,
  type ExtensionServiceAccess,
  type HostSessionsSelector,
  type ModelsService,
  type Api,
  type Model,
  type SessionsHistory,
} from '@felan-ai/agent-core';
import { MEMORY_SCHEDULER_SERVICE, type MemorySchedulerService } from './contracts.js';
import type { LocalMemoryAttachment } from './local/coordinator.js';
import { discoverLocalMemoryProjects, resolveLocalMemoryProject, type LocalMemoryProject } from './local/project.js';
import { acquireSharedLocalMemoryCoordinator, type SharedLocalMemoryCoordinator } from './local/shared.js';

export { MEMORY_SCHEDULER_SERVICE } from './contracts.js';
export type { MemorySchedulerService, MemorySchedulerProjectStatus } from './contracts.js';

export interface MemoryDaemonProviderOptions {
  readonly runtime?: AgentRuntime | (() => AgentRuntime);
  readonly projects?: readonly string[];
  readonly discover?: boolean;
  readonly selector?: (project: LocalMemoryProject) => HostSessionsSelector;
}

const unavailableReason = 'Dream scheduling is unavailable because this host does not provide models; captured memory remains readable.';
const scopeUnavailableReason = 'Dream scheduling is unavailable until the host model scope can be resolved; captured memory remains readable.';
const unavailable = (): never => { throw new Error(unavailableReason); };
const unavailableModels: ModelsService = {
  getAvailable: async () => [],
  completeSimple: unavailable,
  streamSimple: unavailable,
  getAvailableOfType: async () => [],
  generateImages: unavailable,
};

export function createMemoryDaemonProvider(options: MemoryDaemonProviderOptions = {}) {
  return {
    scope: 'daemon' as const,
    provides: [MEMORY_SCHEDULER_SERVICE],
    requires: [HOST_MAINTENANCE_SERVICE],
    optional: [HOST_MODELS_SERVICE],
    async create({ services }: { readonly services: ExtensionServiceAccess }) {
      const projects = new Map<string, { project: LocalMemoryProject; attachment: LocalMemoryAttachment }>();
      let shared: SharedLocalMemoryCoordinator | undefined;
      let active = false;
      let closed = false;
      let activation: Promise<void> | undefined;
      let scanning: Promise<void> | undefined;
      let scanRequested = false;
      let unsubscribe: (() => void) | undefined;
      let timer: ReturnType<typeof setInterval> | undefined;
      let debounce: ReturnType<typeof setTimeout> | undefined;
      let removeAbortListener: (() => void) | undefined;
      let closing: Promise<void> | undefined;
      let forcing: Promise<void> | undefined;
      const scheduler: MemorySchedulerService = {
        status: async () => {
          await scanning?.catch(() => {});
          return Promise.all([...projects.values()].map(async ({ project, attachment }) => ({
          projectRoot: project.canonicalRoot,
            status: await attachment.status(project.canonicalRoot),
          })));
        },
      };

      const close = (mode: 'drain' | 'force'): Promise<void> => {
        closed = true;
        if (closing && mode === 'force') {
          const pendingClose = closing;
          forcing ??= Promise.allSettled([...projects.values()].map(({ attachment }) => attachment.settle('force')))
            .then(() => pendingClose).finally(() => { forcing = undefined; });
          return forcing;
        }
        closing ??= (async () => {
          active = false;
          if (timer) clearInterval(timer);
          if (debounce) clearTimeout(debounce);
          unsubscribe?.();
          removeAbortListener?.();
          const settling = Promise.allSettled([...projects.entries()].map(async ([key, { attachment }]) => {
            try { await attachment.settle(mode); }
            finally {
              await attachment.detach();
              projects.delete(key);
            }
          }));
          await scanning?.catch(() => {});
          const results = await settling;
          await shared?.release();
          shared = undefined;
          const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
          if (errors.length) throw new AggregateError(errors, 'Memory scheduler shutdown failed');
        })().catch(error => { closing = undefined; throw error; });
        return closing;
      };

      return {
        implementations: [{ contract: MEMORY_SCHEDULER_SERVICE, value: scheduler }],
        busy: () => [...projects.values()].some(({ attachment }) => attachment.busy()),
        activate(): Promise<void> {
          if (closed) return Promise.reject(new Error('Memory scheduler is closed'));
          activation ??= (async () => {
            const maintenance = services.get(HOST_MAINTENANCE_SERVICE);
            if (!maintenance) throw new Error('Memory scheduler requires host maintenance');
            maintenance.signal.throwIfAborted();
            const models = services.get(HOST_MODELS_SERVICE);
            const runtime = (typeof options.runtime === 'function' ? options.runtime() : options.runtime) ?? new HostAgentRuntime(maintenance.agentDir, {
              agentDir: maintenance.agentDir,
              agentStorageRoot: maintenance.agentDir,
              sessionStorageRoot: maintenance.agentDir,
              pathAccess: 'host',
            });
            const discovery = { runtime, sessions: maintenance.sessions({ kind: 'all' }) };
            const resolvedProjects = new Map<string, Promise<LocalMemoryProject>>();
            const resolveProject = (cwd: string): Promise<LocalMemoryProject> => {
              let resolved = resolvedProjects.get(cwd);
              if (!resolved) {
                resolved = resolveLocalMemoryProject(discovery, cwd);
                resolvedProjects.set(cwd, resolved);
                void resolved.catch(() => { resolvedProjects.delete(cwd); });
              }
              return resolved;
            };
            const projectHistory = (project: LocalMemoryProject): SessionsHistory => ({
              current: discovery.sessions.current,
              history: (id, request) => discovery.sessions.history(id, request),
              checkpoint: (id, request) => discovery.sessions.checkpoint(id, request),
              list: async (filter, request) => {
                const page = await discovery.sessions.list(filter, request);
                const matches = await Promise.all(page.items.map(async session =>
                  (await resolveProject(session.cwd)).key === project.key));
                return { ...page, items: page.items.filter((_, index) => matches[index]) };
              },
            });
            shared = acquireSharedLocalMemoryCoordinator({ agentDir: maintenance.agentDir });
            active = true;
            const onAbort = (): void => { void close('drain').catch(() => runtime.logger.warn('Memory scheduler drain failed')); };
            maintenance.signal.addEventListener('abort', onAbort, { once: true });
            removeAbortListener = () => maintenance.signal.removeEventListener('abort', onAbort);
            let scope: { models?: readonly Model<Api>[] | undefined; unavailableReason?: string } = { unavailableReason: scopeUnavailableReason };
            const scanProjects = async (): Promise<void> => {
              let nextScope: typeof scope;
              let timeout: ReturnType<typeof setTimeout> | undefined;
              let onScopeAbort: (() => void) | undefined;
              try {
                const interrupted = new Promise<never>((_, reject) => {
                  timeout = setTimeout(() => reject(new Error('Memory model scope resolution timed out')), 30_000);
                  timeout.unref?.();
                  onScopeAbort = () => reject(new DOMException('Memory model scope resolution aborted', 'AbortError'));
                  maintenance.signal.addEventListener('abort', onScopeAbort, { once: true });
                  if (maintenance.signal.aborted) onScopeAbort();
                });
                const allowed = await Promise.race([maintenance.allowedModels(maintenance.signal), interrupted]);
                const scopedModels = allowed?.flatMap(selection => {
                  const model = maintenance.modelRuntime.getModel(selection.provider, selection.id);
                  return model ? [model] : [];
                });
                nextScope = { models: scopedModels };
              } catch (error) {
                if (error instanceof Error && error.name === 'AbortError') nextScope = scope;
                else {
                  if (active) runtime.logger.warn('Memory model scope is unavailable; scheduling remains paused');
                  nextScope = { unavailableReason: scopeUnavailableReason };
                }
              } finally {
                if (timeout) clearTimeout(timeout);
                if (onScopeAbort) maintenance.signal.removeEventListener('abort', onScopeAbort);
              }
              if (!active) return;
              if (JSON.stringify(scope) !== JSON.stringify(nextScope)) {
                scope = nextScope;
                for (const { attachment } of projects.values()) {
                  attachment.setModelSelection(undefined, scope.models, models?.classifier);
                  attachment.setScheduling(!!models && !scope.unavailableReason, models ? scope.unavailableReason : unavailableReason);
                }
              }
              const discovered = options.discover === false ? [] : await discoverLocalMemoryProjects(discovery, maintenance.agentDir);
              discovered.push(...await Promise.all((options.projects ?? []).map(resolveProject)));
              for (const project of discovered) {
                if (!active) return;
                const existing = projects.get(project.key);
                if (existing) {
                  await existing.attachment.status(existing.project.canonicalRoot);
                  continue;
                }
                const attachment = shared!.coordinator.attach({
                  environment: {
                    runtime,
                    sessions: options.selector ? maintenance.sessions(options.selector(project)) : projectHistory(project),
                    openWorker: maintenance.openWorker,
                  },
                  models: models ?? unavailableModels,
                  scheduling: !!models && !scope.unavailableReason,
                  persistent: true,
                  ...(scope.models === undefined ? {} : { scopedModels: scope.models }),
                  ...(!models ? { unavailableReason } : scope.unavailableReason ? { unavailableReason: scope.unavailableReason } : {}),
                  ...(models?.classifier ? { classifier: models.classifier } : {}),
                });
                projects.set(project.key, { project, attachment });
                await attachment.status(project.canonicalRoot);
              }
            };
            const requestScan = (): Promise<void> => {
              if (!active) return Promise.resolve();
              scanRequested = true;
              scanning ??= (async () => {
                do {
                  scanRequested = false;
                  await scanProjects();
                } while (scanRequested && active);
              })().finally(() => { scanning = undefined; });
              return scanning;
            };
            const rescan = (): void => {
              void requestScan().catch(() => runtime.logger.warn('Memory project discovery failed'));
            };
            unsubscribe = shared.coordinator.subscribeStatusChanges(() => {
              if (!active || debounce) return;
              debounce = setTimeout(() => { debounce = undefined; rescan(); }, 2_000);
              debounce.unref?.();
            });
            timer = setInterval(() => { resolvedProjects.clear(); rescan(); }, 10 * 60 * 1_000);
            timer.unref?.();
            // The daemon reports ready only after activation, so the first scan must not hold it.
            rescan();
          })();
          return activation;
        },
        settle: close,
        dispose: () => close('force'),
      };
    },
  };
}

export default createMemoryDaemonProvider();
