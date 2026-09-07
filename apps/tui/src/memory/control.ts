import open from 'open';
import type { ExtensionContext, FelanExtension } from '@felan-ai/agent-core';
import type { LocalMemoryCoordinator, LocalMemoryStatus } from './coordinator.js';
import { safeMemoryText, validMemoryRunId } from './history.js';
import { showMemoryHistory } from './history-view.js';

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
    let activeCwd: string | undefined;
    let unsubscribeStatus: (() => void) | undefined;
    let statusRefresh = 0;
    let lifecycle = 0;
    let startupWarningPending = false;

    const refreshActiveStatus = async (): Promise<void> => {
      const refresh = ++statusRefresh;
      const ctx = activeContext;
      if (!ctx) return;
      const status = await options.coordinator.status(ctx.cwd);
      if (activeContext !== ctx || refresh !== statusRefresh) return;
      updateStatus(ctx, status);
      if (startupWarningPending) {
        if (ctx.hasUI && ctx.mode === 'tui' && status.autoDisabled) {
          startupWarningPending = false;
          notify(ctx, autoDisabledWarning(status), 'warning');
        } else if (status.memoryFingerprint !== undefined) startupWarningPending = false;
      }
    };

    pi.registerCommand('memory', {
      description: 'Inspect memory runs, retry project processing, or open local memory',
      handler: async (args, ctx) => {
        const [action, ...parameters] = args.trim().split(/\s+/u);
        const command = action?.toLowerCase() || 'status';
        const generation = lifecycle;
        const refresh = ++statusRefresh;
        const isCurrent = () => generation === lifecycle;
        const report = (status: LocalMemoryStatus) => {
          if (!isCurrent()) return;
          if (refresh === statusRefresh) updateStatus(ctx, status);
          notify(ctx, formatStatus(status));
        };
        const start = (operation: Promise<LocalMemoryStatus>, message: string) => {
          notify(ctx, message, 'info');
          void operation.then(report).catch(() => {
            if (!isCurrent()) return;
            notify(ctx, 'Memory processing request failed; inspect /memory status.', 'warning');
          });
        };
        if (command === 'runs' && parameters.length <= 1) {
          await showMemoryHistory(ctx, options.agentDir, parameters[0]);
          return;
        }
        if (parameters.length > 0) {
          notify(ctx, 'Usage: /memory status|run|runs [id|latest]|retry|open', 'warning');
          return;
        }
        if (command === 'status') { report(await options.coordinator.status(ctx.cwd)); return; }
        if (command === 'run' || command === 'process') {
          start(options.coordinator.runNow(ctx.cwd), 'Memory processing requested.');
          return;
        }
        if (command === 'retry') {
          start(options.coordinator.retryProject(ctx.cwd), 'Memory retry requested.');
          return;
        }
        if (command === 'open') {
          if (!ctx.hasUI || ctx.mode !== 'tui') {
            notify(ctx, '/memory open requires interactive TUI mode.', 'warning');
            return;
          }
          const directory = await options.coordinator.canonicalDirectory(ctx.cwd);
          if (!isCurrent()) return;
          await open(directory);
          if (isCurrent()) notify(ctx, 'Opened canonical local memory.', 'info');
          return;
        }
        notify(ctx, 'Usage: /memory status|run|runs [id|latest]|retry|open', 'warning');
      },
    });

    pi.on('session_start', async (_event, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const replacement = activeSessionId !== sessionId || activeCwd !== ctx.cwd;
      if (replacement) {
        lifecycle += 1;
        startupWarningPending = true;
      }
      activeContext = ctx;
      activeSessionId = sessionId;
      activeCwd = ctx.cwd;
      const generation = lifecycle;
      unsubscribeStatus?.();
      unsubscribeStatus = options.coordinator.subscribeStatusChanges(() => {
        if (generation !== lifecycle) return;
        void refreshActiveStatus().catch(() => {});
      });
      try {
        await refreshActiveStatus();
      } catch {}
    });

    pi.on('session_shutdown', (_event, ctx) => {
      if (activeSessionId !== ctx.sessionManager.getSessionId() || activeCwd !== ctx.cwd) return;
      lifecycle += 1;
      statusRefresh += 1;
      activeContext = undefined;
      activeSessionId = undefined;
      activeCwd = undefined;
      startupWarningPending = false;
      unsubscribeStatus?.();
      unsubscribeStatus = undefined;
      ctx.ui.setStatus('memory', undefined);
    });

    pi.on('model_select', ({ model }) => {
      options.coordinator.setSelectedModel(model);
    });
  };
}

function updateStatus(
  ctx: ExtensionContext,
  status: LocalMemoryStatus,
): void {
  const pending = status.pendingCheckpoints > 0 ? `${status.pendingCheckpoints} pending` : undefined;
  const activity = status.state === 'processing' ? 'processing'
    : status.nextRetryAt && Date.parse(status.nextRetryAt) > Date.now() ? 'backoff' : undefined;
  ctx.ui.setStatus('memory', !status.enabled ? 'Memory: disabled'
    : activity ? `Memory: ${[activity, pending].filter(Boolean).join(' · ')}`
    : pending ? `Memory: ${pending}` : undefined);
}

function formatStatus(status: LocalMemoryStatus): string {
  const enabled = status.enabled ? 'enabled' : 'disabled';
  const details = [`Local memory: ${enabled}`, status.state, `${status.pendingCheckpoints} pending`];
  if (status.consecutiveFailures) details.push(`${status.consecutiveFailures} consecutive failures`);
  if (status.nextRetryAt) details.push(`retry at ${safeMemoryText(status.nextRetryAt)}`);
  if (status.lastRunId && validMemoryRunId(status.lastRunId)) details.push(`run ${status.lastRunId}`);
  if (status.autoDisabled) details.push(autoDisabledWarning(status));
  if (status.message) details.push(safeMemoryText(status.message));
  return details.join(' · ');
}

function autoDisabledWarning(status: LocalMemoryStatus): string {
  const disabled = status.autoDisabled!;
  const run = validMemoryRunId(disabled.runId) ? ` Run: ${disabled.runId}.` : '';
  const reason = safeMemoryText(disabled.reason) || 'repeated failures';
  return `Memory processing automatically disabled for this project: ${reason}.${run} Inspect /memory runs; use /memory retry to recover.`;
}

function notify(ctx: ExtensionContext, message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
  ctx.ui.notify(message, level);
}
