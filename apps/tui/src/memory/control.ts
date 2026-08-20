import open from 'open';
import type { ExtensionContext, FelanExtension } from '@felan-ai/agent-core';
import { setLocalMemoryProcessingEnabled } from '../settings.js';
import { LocalMemoryCoordinator } from './coordinator.js';

export interface CreateLocalMemoryControlExtensionOptions {
  readonly coordinator: LocalMemoryCoordinator;
  readonly agentDir: string;
}

export function createLocalMemoryControlExtension(
  options: CreateLocalMemoryControlExtensionOptions,
): FelanExtension {
  return (pi) => {
    let activeContext: ExtensionContext | undefined;
    let activeSessionId: string | undefined;
    let unsubscribeStatus: (() => void) | undefined;
    let statusRefresh = 0;

    const refreshActiveStatus = async (): Promise<void> => {
      const refresh = ++statusRefresh;
      const ctx = activeContext;
      if (!ctx) return;
      const status = await options.coordinator.status(ctx.cwd);
      if (activeContext !== ctx || refresh !== statusRefresh) return;
      updateStatus(ctx, status);
    };

    pi.registerCommand('memory', {
      description: 'Inspect, run, enable, disable, or open local project memory',
      handler: async (args, ctx) => {
        const command = args.trim().toLowerCase() || 'status';
        if (command === 'status') {
          await showStatus(options.coordinator, ctx.cwd, ctx);
          return;
        }
        if (command === 'run' || command === 'process') {
          const status = await options.coordinator.runNow(ctx.cwd);
          updateStatus(ctx, status);
          notify(ctx, formatStatus(status));
          return;
        }
        if (command === 'enable' || command === 'on') {
          await setMemoryEnabled(options, true);
          notify(ctx, 'Local memory processing enabled.');
          return;
        }
        if (command === 'disable' || command === 'off') {
          await setMemoryEnabled(options, false);
          notify(ctx, 'Local memory processing disabled. Existing memory remains readable.');
          return;
        }
        if (command === 'open') {
          if (!ctx.hasUI || ctx.mode !== 'tui') {
            notify(ctx, '/memory open requires interactive TUI mode.', 'warning');
            return;
          }
          const directory = await options.coordinator.canonicalDirectory(ctx.cwd);
          await open(directory);
          notify(ctx, 'Opened canonical local memory.', 'info');
          return;
        }
        notify(ctx, 'Usage: /memory status|run|enable|disable|open', 'warning');
      },
    });

    pi.on('session_start', async (_event, ctx) => {
      activeContext = ctx;
      activeSessionId = ctx.sessionManager.getSessionId();
      unsubscribeStatus?.();
      unsubscribeStatus = options.coordinator.subscribeStatusChanges(() => {
        void refreshActiveStatus().catch(() => {});
      });
      try {
        await refreshActiveStatus();
      } catch {}
    });

    pi.on('session_shutdown', (_event, ctx) => {
      if (activeSessionId !== ctx.sessionManager.getSessionId()) return;
      statusRefresh += 1;
      activeContext = undefined;
      activeSessionId = undefined;
      unsubscribeStatus?.();
      unsubscribeStatus = undefined;
      ctx.ui.setStatus('memory', undefined);
    });

    pi.on('model_select', ({ model }) => {
      options.coordinator.setSelectedModel(model);
    });
  };
}

async function setMemoryEnabled(
  options: CreateLocalMemoryControlExtensionOptions,
  enabled: boolean,
): Promise<void> {
  options.coordinator.setEnabled(enabled);
  await setLocalMemoryProcessingEnabled(options.agentDir, enabled);
}

async function showStatus(
  coordinator: LocalMemoryCoordinator,
  cwd: string,
  ctx: ExtensionContext,
  quiet = false,
): Promise<void> {
  const status = await coordinator.status(cwd);
  const message = formatStatus(status);
  updateStatus(ctx, status);
  if (!quiet) notify(ctx, message);
}

function updateStatus(
  ctx: ExtensionContext,
  status: Awaited<ReturnType<LocalMemoryCoordinator['status']>>,
): void {
  ctx.ui.setStatus('memory', status.pendingCheckpoints > 0 ? `Memory: ${status.pendingCheckpoints} pending` : undefined);
}

function formatStatus(status: Awaited<ReturnType<LocalMemoryCoordinator['status']>>): string {
  const enabled = status.enabled ? 'enabled' : 'disabled';
  const pending = `${status.pendingCheckpoints} pending`;
  return `Local memory: ${enabled}, ${status.state}, ${pending}${status.message ? ` — ${status.message}` : ''}`;
}

function notify(ctx: ExtensionContext, message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
  ctx.ui.notify(message, level);
}
