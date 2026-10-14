import { createHash } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';
import { getLocalSkillSources } from './local-resources.js';
import { SESSIONS_SERVICE, bindFelanExtension, type SessionsService } from '@felan-ai/agent-core';
import type { SessionExecutionPort, SessionExtensionBindings, SessionExtensionContext, ExecutionSettings } from '@felan-ai/daemon/provider';
import { bindExecutionSession } from './execution-binding.js';
import { type LocalExecutionRoot, type LocalExecutionSession } from './extension-services.js';
import { createHerdrExtension, type HerdrActivity } from './herdr.js';
import { SavingsService, createModelPriceSource } from './savings.js';
import { HERDR_BLOCKED_EVENT } from './herdr.js';
import { createSavingsCommandExtension } from '../savings-command.js';

export function createLocalExecutionRoots() {
  const roots = new Map<string, LocalExecutionRoot>();
  async function createRoot(context: Omit<SessionExtensionContext, 'services'>): Promise<LocalExecutionRoot> {
    const runtime = context.runtime;
    const savings = new SavingsService({ runtime, rootSessionId: context.rootSessionId,
      projectKey: createHash('sha256').update(context.resources.cwd).digest('hex'),
      priceSource: createModelPriceSource(reference => {
        const model = context.modelRuntime.getModel(reference.provider, reference.id);
        return model && { model: reference, ...model.cost, fingerprint: createHash('sha256').update(JSON.stringify(model.cost)).digest('hex') };
      }) });
    let closing: Promise<void> | undefined;
    const root: LocalExecutionRoot = {
      savings,
      async settle() { await savings.settle(); },
      close() {
        closing ??= (async () => {
          await savings.settle();
          if (roots.get(context.rootSessionId) === root) roots.delete(context.rootSessionId);
        })();
        return closing;
      },
    };
    roots.set(context.rootSessionId, root); return root;
  }

  return {
    async open(context: Omit<SessionExtensionContext, 'services'>, port: SessionExecutionPort) {
      const isRoot = port.current.id === port.current.root;
      if (!isRoot && !roots.has(port.current.root)) await port.ensureRoot();
      const root = isRoot ? await createRoot(context) : roots.get(port.current.root);
      if (!root) throw new Error('Root execution services are unavailable.');
      return root;
    },
    async dispose() { for (const root of [...roots.values()].reverse()) await root.close(); },
  };
}

const executionRoots = createLocalExecutionRoots();

export async function createLocalExecutionSession(session: SessionExtensionContext, port: SessionExecutionPort, roots = executionRoots) {
  const root = await roots.open(session, port);
  const isRoot = port.current.id === port.current.root;
  let attention: ((active: boolean, label?: string) => void) | undefined;
  const notifications = bindFelanExtension('@felan-ai/local-services/notifications', pi => {
    attention = (active, label) => pi.events.emit(HERDR_BLOCKED_EVENT, { active, label });
    pi.on('session_shutdown', () => { attention = undefined; });
  }, session.runtime, session.resources.agentDir);
  if (typeof notifications !== 'function') notifications.hidden = true;
  const state = { context: session, port, root, isRoot,
    attention: (active, label) => attention?.(active, label),
  } satisfies LocalExecutionSession;
  return { session: state, inlineExtensions: [notifications, createSavingsCommandExtension(root.savings)],
    async dispose() { if (isRoot) await root.close(); },
  };
}

export function createLocalExecutionServices(roots = executionRoots) {
  return async (context: SessionExtensionContext, port: SessionExecutionPort): Promise<SessionExtensionBindings> => {
    const local = await createLocalExecutionSession(context, port, roots);
    const state = local.session;
    const { root, isRoot } = state;
    let releaseParent: (() => void) | undefined;
    let releaseService: (() => void) | undefined;
    return {
      services: context.services, savings: root.savings,
      inlineExtensions: [...local.inlineExtensions, createHerdrExtension({ activity: createSessionActivity(context.services.get(SESSIONS_SERVICE)!) })],
      importExtension: context.importExtension,
      async onSession(session) {
        const sources = getLocalSkillSources(context.resources.cwd);
        for (const skill of session.resourceLoader.getSkills().skills) {
          const source = sources.find(source => {
            const path = relative(source.path, skill.filePath);
            return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
          });
          if (source) skill.sourceInfo = { ...skill.sourceInfo, scope: source.scope };
        }
        if (isRoot) {
          releaseService = port.registerService({ disposeWhenIdle: true, busy: () => root.savings.hasPendingWork(), settle: mode => root.settle(mode), async dispose() {} });
          const settings = context.settingsManager.getSettings() as { felanSubagents?: ExecutionSettings };
          port.configureExecutions(settings.felanSubagents ?? {});
        }
        releaseParent = bindExecutionSession({ port, session });
      },
      async dispose() {},
      async disposeUi() { releaseParent?.(); await local.dispose(); releaseService?.(); },
    };
  };
}

export function createSessionActivity(sessions: SessionsService): HerdrActivity {
  let pending = false;
  return {
    hasPendingWork: () => pending,
    subscribe(listener) {
      let closed = false;
      let refreshing = false;
      let dirty = false;
      const refresh = async () => {
        dirty = true;
        if (refreshing) return;
        refreshing = true;
        try {
          do {
            dirty = false;
            let next = false;
            let cursor: string | undefined;
            do {
              const page = await sessions.executions({ includeDescendants: true, ...(cursor ? { cursor } : {}) });
              next ||= page.items.some(row => row.state === 'queued' || row.state === 'running'
                || row.parent === sessions.current.id && row.completionPending === true);
              cursor = page.nextCursor;
            } while (cursor && !closed);
            if (!closed) { pending = next; listener(); }
          } while (dirty && !closed);
        } catch {}
        finally { refreshing = false; }
      };
      const unsubscribe = sessions.subscribe(() => { void refresh(); });
      void refresh();
      return () => { closed = true; unsubscribe(); };
    },
  };
}
