import { createHash } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';
import { getLocalSkillSources } from './local-resources.js';
import type { SessionExecutionPort, SessionExtensionBindings, SessionExtensionContext, ExecutionSettings } from '@felan-ai/daemon/provider';
import { bindExecutionSession } from './execution-binding.js';
import { type LocalExecutionRoot, type LocalExecutionSession } from './extension-services.js';
import { SavingsService, createModelPriceSource } from './savings.js';
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
  const state = { context: session, port, root, isRoot } satisfies LocalExecutionSession;
  return { session: state, inlineExtensions: [createSavingsCommandExtension(root.savings)],
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
      inlineExtensions: local.inlineExtensions,
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
