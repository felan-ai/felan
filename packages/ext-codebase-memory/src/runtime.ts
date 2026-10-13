import {
  associateExtensionConfig,
  RUNTIME_DEPENDENCIES_SERVICE,
  RUNTIME_LIFETIME_SERVICE,
  type ConfiguredFelanExtension,
  type ExtensionContext,
  type FelanExtension,
} from '@felan-ai/agent-core';
import { type CodebaseMemoryTelemetry } from './cache.js';
import {
  acquireCbmClient,
  detectCbm,
  type CbmClientLease,
  type CbmDetection,
} from './client.js';
import { CODEBASE_MEMORY_CONFIG } from './config.js';
import { registerGrepAugmentation } from './grep-augmentation.js';
import { ProjectService, SymbolService, type IndexResult } from './services.js';
import { registerExecutionTools } from './execution-tools.js';

export const CODEBASE_MEMORY_CAPABILITY_INSTRUCTIONS = `Use Codebase Memory for structural code exploration before broad raw searches: read_symbol reads a known symbol, search_and_read_symbols finds and reads likely implementations, search_code searches indexed text, and codebase_memory proxies other structural queries or refreshes with {command:"index_repository"}. A background index starts at session startup through a lazy root-session MCP frontend shared with subagents and refreshes only when the model calls index_repository or the user invokes /codebase-memory. It may be stale after edits. Direct reads, grep, compiler output, and tests remain authoritative; grep output can include bounded Codebase Memory augmentation. Keep symbol reads focused and at no more than 220 lines per symbol.`;

export interface CodebaseMemoryExtensionOptions {
  readonly telemetry?: CodebaseMemoryTelemetry;
  readonly log?: (level: 'error' | 'info', message: string, fields: Record<string, unknown>) => void;
}

interface IndexSession {
  active: boolean;
}

export function createCodebaseMemoryExtension(options: CodebaseMemoryExtensionOptions = {}): ConfiguredFelanExtension {
  const log = options.log ?? ((level, message, fields) => {
    if (level === 'error') console.error(`[codebase-memory] ERROR ${message}`, fields);
    else console.info(`[codebase-memory] ${message}`, fields);
  });
  const extension: FelanExtension = async (pi) => {
    const dependencies = pi.services.get(RUNTIME_DEPENDENCIES_SERVICE);
    const setupController = new AbortController();
    let installJob: Promise<void> | undefined;
    const telemetry = options.telemetry ?? ((event, fields) => {
      if (pi.runtime.kind !== 'host') log('info', `telemetry.${event}`, fields);
    });
    let detection: CbmDetection = await detectCbm(pi.runtime);
    let hintShown = false;
    let clientLease: CbmClientLease | undefined;
    let projects: ProjectService | undefined;
    let activeIndexSession: IndexSession | undefined;
    const indexing = new Set<Promise<void>>();
    const refreshIndex = (ctx: ExtensionContext, session?: IndexSession) => {
      const work = refresh(projects!, ctx, session);
      indexing.add(work);
      void work.then(() => indexing.delete(work), () => indexing.delete(work));
      return work;
    };
    let disposal: Promise<void> | undefined;
    const dispose = () => disposal ??= (async () => {
      setupController.abort();
      if (activeIndexSession) activeIndexSession.active = false;
      activeIndexSession = undefined;
      try {
        await clientLease?.release();
        await Promise.allSettled([...indexing, ...(installJob ? [installJob] : [])]);
      } finally { unregister?.(); }
    })();
    const unregister = pi.services.get(RUNTIME_LIFETIME_SERVICE)?.register({
      busy: () => !!installJob || indexing.size > 0 || !!clientLease?.client.hasPendingWork(),
      async settle(mode) {
        if (mode === 'drain') {
          await Promise.allSettled([...indexing, ...(installJob ? [installJob] : [])]);
          await clientLease?.client.waitForIdle();
        }
        await dispose();
      },
      dispose,
    });

    const activate = async (available: Extract<CbmDetection, { available: true }>) => {
      clientLease = await acquireCbmClient(pi.runtime, available.invocation);
      const client = clientLease.client;
      const configured = pi.config.maxCacheBytes;
      const maxCacheBytes = typeof configured === 'number' && configured > 0 ? configured : undefined;
      const autoIndexPath = typeof pi.config.autoIndexPath === 'string' && pi.config.autoIndexPath.trim()
        ? pi.config.autoIndexPath
        : undefined;
      projects = new ProjectService(pi.runtime, client, maxCacheBytes, telemetry, autoIndexPath);
      const symbols = new SymbolService(client, projects);
      const mode = pi.config.mode === 'direct' || pi.config.mode === 'proxy' ? pi.config.mode : 'curated';
      pi.registerCapability({ id: 'codebase-memory', instructions: capabilityInstructions(mode) });
      registerExecutionTools(pi, client, projects, symbols, mode);
      registerGrepAugmentation(pi, client, projects, telemetry);
    };

    if (detection.available) await activate(detection);
    else if (pi.runtime.kind !== 'host') {
      log('error', 'Compatible codebase-memory-mcp binary is unavailable; extension disabled nonfatally.', {
        runtimeKind: pi.runtime.kind,
        reason: detection.reason,
      });
    }

    pi.registerCommand('codebase-memory', {
      description: 'Refresh the repository index or explicitly install Codebase Memory',
      handler: async (args, ctx) => {
        const action = args.trim().toLowerCase();
        if (action && action !== 'install' && action !== 'refresh') {
          await pi.ui.notify({ text: 'Usage: /codebase-memory [refresh|install]', level: 'warning' });
          return;
        }
        if (action === 'install') {
          if (!dependencies) {
            await pi.ui.notify({ text: 'Codebase Memory installation is unavailable: no runtime-dependencies provider is configured.', level: 'warning' });
            return;
          }
          if (installJob) {
            await pi.ui.notify({ text: 'Codebase Memory installation is already in progress.', level: 'warning' });
            return;
          }
          const signal = AbortSignal.any([setupController.signal, ...(ctx.signal ? [ctx.signal] : [])]);
          const job = (async () => {
            signal.throwIfAborted();
            const outcome = await dependencies.install({ id: 'codebase-memory' }, { signal }).catch((error: unknown) => {
              if (signal.aborted && (error === signal.reason || error instanceof Error && error.name === 'AbortError')) {
                return { status: 'cancelled' as const, message: 'Codebase Memory setup request cancelled.' };
              }
              throw error;
            });
            if (outcome.status !== 'installed') {
              await pi.ui.notify({ text: outcome.message, level: 'warning' });
              return;
            }
            detection = await detectCbm(pi.runtime);
            await pi.ui.notify({ text: detectionMessage(detection), level: detection.available ? 'info' : 'warning' });
          })();
          installJob = job;
          try { await job; } finally { if (installJob === job) installJob = undefined; }
          return;
        }
        if (!projects) {
          await pi.ui.notify({ text: detection.available
              ? 'Codebase Memory was installed after this session started. Restart Felan to activate it.'
              : `${detection.reason} Use /codebase-memory install to install it.`,
            level: 'warning' });
          return;
        }
        await refreshIndex(ctx, activeIndexSession);
      },
    });

    pi.on('session_start', (_event, ctx) => {
      if (activeIndexSession) activeIndexSession.active = false;
      activeIndexSession = undefined;
      if (!projects) {
        if (pi.runtime.kind === 'host' && ctx.hasUI && !hintShown) {
          hintShown = true;
          ctx.ui.notify('Codebase Memory is unavailable. Run /codebase-memory install to install the reviewed binary.', 'info');
        }
        return;
      }
      const session = { active: true };
      activeIndexSession = session;
      void refreshIndex(ctx, session);
    });

    pi.on('session_shutdown', async (_event, ctx) => {
      try {
        ctx.ui.setStatus('codebase-memory', undefined);
      } finally {
        await dispose();
      }
    });
  };
  associateExtensionConfig(extension, CODEBASE_MEMORY_CONFIG);
  return Object.assign(extension, { serviceRequirements: { optional: [RUNTIME_DEPENDENCIES_SERVICE, RUNTIME_LIFETIME_SERVICE] } });
}

function capabilityInstructions(mode: 'curated' | 'direct' | 'proxy'): string {
  if (mode === 'direct') return 'Use the Codebase Memory tools for structural code exploration. These tools map directly to the bounded codebase-memory-mcp command surface.';
  if (mode === 'proxy') return 'Use codebase_memory with an allowed command and arguments for structural code exploration. The command surface is bounded.';
  return CODEBASE_MEMORY_CAPABILITY_INSTRUCTIONS;
}

function detectionMessage(detection: CbmDetection): string {
  return detection.available ? 'Codebase Memory installed. Restart Felan to activate it.' : detection.reason;
}

async function refresh(projects: ProjectService, ctx: ExtensionContext, session?: IndexSession): Promise<void> {
  if (session && !session.active) return;
  let signal: AbortSignal | undefined;
  try {
    ctx.ui.setStatus('codebase-memory', 'cbm: idx');
    signal = ctx.signal;
  } catch (error) {
    if (isStaleExtensionContextError(error)) return;
    throw error;
  }
  let failed = false;
  let failure: unknown;
  let result: IndexResult | undefined;
  try {
    result = await projects.index(signal);
  } catch (error) {
    failed = true;
    failure = error;
  }
  if (session && !session.active) return;
  try {
    ctx.ui.setStatus('codebase-memory', undefined);
    if (result?.status === 'skipped') {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Codebase Memory: ${result.reason} — skipped auto-indexing. Launch Felan from inside a project directory, or ask the agent to index it explicitly.`,
          'warning',
        );
      }
      return;
    }
    if (failed && ctx.hasUI) {
      ctx.ui.notify(
        `Codebase Memory index failed: ${failure instanceof Error ? failure.message : String(failure)}. `
          + 'Automatic recovery is attempted for known daemon-coordination failures; if this persists, close other Felan sessions and retry.',
        'warning',
      );
    }
  } catch (error) {
    if (!isStaleExtensionContextError(error)) throw error;
  }
}

function isStaleExtensionContextError(error: unknown): boolean {
  return error instanceof Error
    && error.message.startsWith('This extension ctx is stale after session replacement or reload.');
}

const codebaseMemoryExtension = createCodebaseMemoryExtension();
export default codebaseMemoryExtension;
export { CODEBASE_MEMORY_CONFIG } from './config.js';
export {
  CODEBASE_MEMORY_VERSION as MANAGED_CODEBASE_MEMORY_VERSION,
  detectCbm as inspectCodebaseMemoryRuntime,
} from './client.js';
export { installManagedCbm as installManagedCodebaseMemory } from './installer.js';

