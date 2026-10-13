import type { ExtensionContext, FelanExtension } from '@felan-ai/agent-core';
import type { LocalMemoryCoordinator, LocalMemoryStatus } from './coordinator.js';
import { sanitizeMemoryDiagnostic } from '../diagnostics.js';
const safeMemoryText = (value: unknown) => sanitizeMemoryDiagnostic(value).replace(/\s+/gu, ' ').trim().slice(0, 500);
const validMemoryRunId = (value: string) => /^[a-zA-Z0-9_-]{1,128}$/u.test(value);

export interface MemoryControlPresentationHost {
  showHistory(ctx: ExtensionContext, agentDir: string, status: string, signal: AbortSignal): Promise<void>;
  openDirectory(directory: string, signal: AbortSignal): Promise<void>;
}

export interface CreateMemoryControlExtensionOptions {
  readonly coordinator: LocalMemoryCoordinator;
  readonly agentDir: string;
  readonly presentation: MemoryControlPresentationHost;
}

export function createMemoryControlExtension(
  options: CreateMemoryControlExtensionOptions,
): FelanExtension {
  return (pi) => {
    let lifetime = new AbortController();
    const views = new Set<Promise<void>>();
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
        if (status.autoDisabled) {
          startupWarningPending = false;
          notify(ctx, autoDisabledWarning(status), 'warning');
        } else if (status.memoryFingerprint !== undefined) startupWarningPending = false;
      }
    };

    pi.registerCommand('memory', {
      description: 'Inspect local memory, run processing, or open the memory directory',
      handler: async (args, ctx) => {
        if (lifetime.signal.aborted) return;
        const [action, ...parameters] = args.trim().split(/\s+/u);
        const command = action?.toLowerCase() || '';
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
            notify(ctx, 'Memory processing request failed; inspect /memory.', 'warning');
          });
        };
        if (parameters.length > 0) {
          notify(ctx, 'Usage: /memory | /memory run | /memory open', 'warning');
          return;
        }
        if (command === '') {
          try {
            const status = await options.coordinator.status(ctx.cwd);
            if (!isCurrent() || lifetime.signal.aborted) return;
            const view = options.presentation.showHistory(ctx, options.agentDir, formatStatus(status), lifetime.signal);
            views.add(view);
            try { await view; } finally { views.delete(view); }
          } catch {
            if (isCurrent() && !lifetime.signal.aborted) notify(ctx, 'Memory overview could not be opened.', 'warning');
          }
          return;
        }
        if (command === 'run') {
          const operation = options.coordinator.status(ctx.cwd).then((status) => {
            const retry = status.autoDisabled !== undefined
              || (status.nextRetryAt !== undefined && Date.parse(status.nextRetryAt) > Date.now());
            return retry
              ? options.coordinator.retryProject(ctx.cwd)
              : options.coordinator.runNow(ctx.cwd);
          });
          start(operation, 'Memory processing requested.');
          return;
        }
        if (command === 'open') {
          const directory = await options.coordinator.canonicalDirectory(ctx.cwd);
          if (!isCurrent() || lifetime.signal.aborted) return;
          await options.presentation.openDirectory(directory, lifetime.signal);
          if (isCurrent()) notify(ctx, 'Opened canonical local memory.', 'info');
          return;
        }
        notify(ctx, 'Usage: /memory | /memory run | /memory open', 'warning');
      },
    });

    pi.on('session_start', async (_event, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const replacement = activeSessionId !== sessionId || activeCwd !== ctx.cwd;
      if (replacement) {
        lifetime.abort();
        await Promise.allSettled([...views]);
        lifetime = new AbortController();
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

    pi.on('session_shutdown', async (_event, ctx) => {
      if (activeSessionId !== ctx.sessionManager.getSessionId() || activeCwd !== ctx.cwd) return;
      lifecycle += 1;
      statusRefresh += 1;
      activeContext = undefined;
      activeSessionId = undefined;
      activeCwd = undefined;
      startupWarningPending = false;
      unsubscribeStatus?.();
      unsubscribeStatus = undefined;
      await pi.ui.removeStatus('memory').catch(() => {});
      lifetime.abort();
      await Promise.allSettled([...views]);
    });

    pi.on('model_select', ({ model }) => {
      options.coordinator.setSelectedModel(model);
    });

function updateStatus(
  ctx: ExtensionContext,
  status: LocalMemoryStatus,
): void {
  const pending = status.pendingCheckpoints > 0 ? `${status.pendingCheckpoints} pending` : undefined;
  const activity = status.state === 'processing' ? 'processing'
    : status.nextRetryAt && Date.parse(status.nextRetryAt) > Date.now() ? 'backoff' : undefined;
  const text = !status.enabled ? 'Memory: disabled'
    : activity ? `Memory: ${[activity, pending].filter(Boolean).join(' · ')}`
    : pending ? `Memory: ${pending}` : undefined;
  void (text === undefined ? pi.ui.removeStatus('memory') : pi.ui.status({ id: 'memory', kind: 'status', key: 'memory', value: { kind: 'text', text }, fallback: text })).catch(() => {});
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
  return `Memory processing automatically disabled for this project: ${reason}.${run} Open /memory to inspect the run; use /memory run to recover.`;
}

function notify(ctx: ExtensionContext, message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
  void pi.ui.notify({ text: message, level }).catch(() => {});
}

  };
}
