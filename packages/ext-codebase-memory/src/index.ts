import { associateExtensionConfig, type FelanExtension, type FelanExtensionAPI } from '@felan-ai/agent-core';
import { detectCbmBinary } from './binary/detect.js';
import { enforceCacheLimit, resolveCacheCap } from './cache/lru.js';
import { CbmClient } from './cbm/client.js';
import { codebaseMemoryConfig, CODEBASE_MEMORY_CONFIG } from './config.js';
import { OutputService } from './domain/output.js';
import { ProjectService } from './domain/project.js';
import { QueryService } from './domain/query.js';
import { SymbolService } from './domain/symbols.js';
import { CbmAugmentService } from './extension/augment.js';
import { registerCodebaseMemoryCommand } from './extension/commands.js';
import { registerLifecycle } from './extension/lifecycle.js';
import { createCodebaseMemorySessionState, type CodebaseMemorySessionState } from './extension/session-state.js';
import { installManagedCbm } from './installer.js';
import { isRuntimePathUnderRoot, joinRuntimePath } from './runtime-path.js';
import { registerCbmTools } from './tools/registry.js';

const codebaseMemoryExtension: FelanExtension = async (pi) => {
  if (pi.config?.disabled === true) return;
  const config = codebaseMemoryConfig(pi.config ?? {});
  let projects: ProjectService | undefined;
  let state: CodebaseMemorySessionState | undefined;
  registerCodebaseMemoryCommand(pi, {
    install: (onStatus) => installManagedCbm(pi.runtime, onStatus),
    refresh: async (cwd, signal) => projects?.indexCurrentRepo(cwd, signal) ?? { status: 'unavailable' },
  });

  const binary = await detectCbmBinary(pi.runtime).catch((error) => ({
    available: false as const,
    reason: error instanceof Error ? error.message : String(error),
  }));
  if (!binary.available) {
    registerUnavailableSessionStart(pi, binary.reason);
    return;
  }

  try {
    assertStorageRoot(pi.runtime.storage('agent').root, pi.runtime.cwd);
    await pi.runtime.storage('agent').mkdir('codebase-memory/home', { recursive: true });
    await pi.runtime.storage('agent').mkdir('codebase-memory/cache', { recursive: true });
    const cbm = new CbmClient(pi.runtime, binary.command, { queryTimeoutMs: config.queryTimeoutMs });
    projects = new ProjectService(cbm, pi.runtime.cwd, config.indexTimeoutMs, async (listed) => {
      await enforceCacheLimit(
        pi.runtime,
        cbm,
        listed,
        resolveCacheCap(pi.runtime.kind, config.maxCacheBytes || undefined),
        (event) => pi.appendEntry('codebase-memory-telemetry', event),
      );
    });
    const output = new OutputService(config.maxSymbolLines);
    const query = new QueryService(cbm, projects, output);
    const symbols = new SymbolService(cbm, projects, output);
    state = createCodebaseMemorySessionState();
    registerCbmTools(pi, { cbm, projects, output, query, symbols, state });
    registerLifecycle(pi, {
      projects,
      state,
      ...(config.augmentation ? { augment: new CbmAugmentService(cbm, projects, config.augmentTimeoutMs) } : {}),
    });
  } catch (error) {
    state?.disable();
    projects = undefined;
    registerUnavailableSessionStart(pi, error instanceof Error ? error.message : String(error));
  }
};

associateExtensionConfig(codebaseMemoryExtension, CODEBASE_MEMORY_CONFIG);
export { CODEBASE_MEMORY_CONFIG } from './config.js';
export default codebaseMemoryExtension;

function assertStorageRoot(root: string, cwd: string): void {
  const target = joinRuntimePath(root, 'codebase-memory');
  if (root === '/' || root === '\\' || !isRuntimePathUnderRoot(target, root, cwd)) {
    throw new Error('Codebase Memory storage root assertion failed');
  }
}

function registerUnavailableSessionStart(pi: FelanExtensionAPI, reason: string): void {
  let hinted = false;
  pi.on('session_start', (_event, ctx) => {
    try { ctx.ui.setStatus('codebase-memory', 'cbm: off'); } catch {}
    if (hinted) return;
    hinted = true;
    if (pi.runtime.kind === 'host') {
      try {
        ctx.ui.notify('Codebase Memory is unavailable. Run /codebase-memory install to add the pinned runtime.', 'info');
      } catch {}
    } else {
      console.error(`[codebase-memory] ERROR: ${reason}`);
    }
  });
}
