import type { ExtensionContext, FelanExtensionAPI } from '@felan-ai/agent-core';
import { promptCacheState } from './internal/cache-state.js';

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface CacheExpiryCompactionOptions {
  readonly enabled: boolean;
  readonly minContextTokens: number;
  readonly canCompact: (ctx: ExtensionContext) => { readonly ok: true } | { readonly ok: false; readonly reason: string };
  readonly leadMs?: number;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface CacheExpiryCompaction {
  /** True exactly once for the session_before_compact run that this scheduler started. */
  takeTrigger(): boolean;
}

export function registerCacheExpiryCompaction(
  pi: FelanExtensionAPI,
  options: CacheExpiryCompactionOptions,
): CacheExpiryCompaction {
  if (!options.enabled) return { takeTrigger: () => false };

  const now = options.now ?? Date.now;
  const leadMs = options.leadMs ?? 20_000;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref());
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let timer: { handle: unknown } | undefined;
  let attempt: { triggered: boolean } | undefined;

  const log = (ctx: ExtensionContext, reason: string, expiresAt?: number, contextTokens?: number): void => {
    try {
      const secondsLeft = expiresAt === undefined ? undefined : Math.max(0, Math.ceil((expiresAt - now()) / 1_000));
      pi.runtime.logger.child({ component: 'session-compaction' }).debug({
        sessionId: ctx.sessionManager.getSessionId().slice(0, 256),
        reason: reason.slice(0, 256),
        ...(secondsLeft === undefined || !Number.isFinite(secondsLeft) ? {} : { secondsLeft }),
        ...(contextTokens === undefined || !Number.isFinite(contextTokens) ? {} : { contextTokens }),
      }, 'session compaction cache expiry');
    } catch {}
  };

  const cancelTimer = (): void => {
    const previous = timer;
    timer = undefined;
    if (previous) {
      try { clearTimer(previous.handle); } catch {}
    }
  };

  const fire = (ctx: ExtensionContext): void => {
    let expiresAt: number | undefined;
    try {
      expiresAt = promptCacheState(ctx.model, ctx.sessionManager.getBranch()).expiresAt;
      if (expiresAt === undefined || !Number.isFinite(expiresAt)) {
        log(ctx, 'cache-expiry-unknown');
        return;
      }
      const time = now();
      if (expiresAt > time + leadMs + 1_000) {
        schedule(undefined, ctx);
        return;
      }
      if (expiresAt <= time) {
        log(ctx, 'cache-expired', expiresAt);
        return;
      }
      if (pi.getSettings().compaction?.enabled === false) {
        log(ctx, 'auto-compaction-disabled', expiresAt);
        return;
      }
      if (!ctx.isIdle()) {
        log(ctx, 'agent-busy', expiresAt);
        return;
      }
      if (ctx.hasPendingMessages()) {
        log(ctx, 'pending-messages', expiresAt);
        return;
      }
      const contextTokens = ctx.getContextUsage()?.tokens;
      if (typeof contextTokens !== 'number' || !Number.isFinite(contextTokens)) {
        log(ctx, 'context-usage-unavailable', expiresAt);
        return;
      }
      if (!(contextTokens >= options.minContextTokens)) {
        log(ctx, 'context-too-small', expiresAt, contextTokens);
        return;
      }
      const eligibility = options.canCompact(ctx);
      if (!eligibility.ok) {
        log(ctx, eligibility.reason, expiresAt, contextTokens);
        return;
      }

      const current = { triggered: true };
      attempt = current;
      const finish = (): void => {
        if (attempt === current) attempt = undefined;
      };
      log(ctx, 'compact', expiresAt, contextTokens);
      try {
        ctx.ui.notify(`Prompt cache expires in ${Math.ceil((expiresAt - time) / 1_000)}s; compacting the idle session so the next request starts smaller.`, 'info');
      } catch {}
      try {
        ctx.compact({
          onComplete: finish,
          onError: (error) => {
            finish();
            const reason = error.name === 'AbortError' || /cancel/i.test(error.message)
              ? 'compaction-cancelled' : 'compaction-failed';
            log(ctx, reason, expiresAt, contextTokens);
          },
        });
      } catch {
        finish();
        log(ctx, 'compaction-failed', expiresAt, contextTokens);
      }
    } catch {
      log(ctx, 'scheduler-error', expiresAt);
    }
  };

  const schedule = (_event: unknown, ctx: ExtensionContext): void => {
    cancelTimer();
    try {
      if (attempt) {
        log(ctx, 'compaction-in-progress');
        return;
      }
      const { expiresAt } = promptCacheState(ctx.model, ctx.sessionManager.getBranch());
      if (expiresAt === undefined || !Number.isFinite(expiresAt)) {
        log(ctx, 'cache-expiry-unknown');
        return;
      }
      const time = now();
      if (expiresAt <= time) {
        log(ctx, 'cache-expired', expiresAt);
        return;
      }
      const scheduled = { handle: undefined as unknown };
      timer = scheduled;
      scheduled.handle = setTimer(() => {
        if (timer !== scheduled) return;
        timer = undefined;
        fire(ctx);
      }, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, expiresAt - leadMs - time)));
      log(ctx, 'scheduled', expiresAt);
    } catch {
      cancelTimer();
      log(ctx, 'scheduler-error');
    }
  };

  const cancel = (_event: unknown, ctx: ExtensionContext): void => {
    cancelTimer();
    log(ctx, 'cancelled');
  };
  const reset = (event: unknown, ctx: ExtensionContext): void => {
    cancel(event, ctx);
    attempt = undefined;
  };

  pi.on('session_start', schedule);
  pi.on('agent_settled', schedule);
  pi.on('session_tree', schedule);
  pi.on('model_select', schedule);
  pi.on('agent_start', cancel);
  pi.on('session_compact', reset);
  pi.on('session_shutdown', reset);
  pi.on('session_before_switch', reset);
  pi.on('session_before_fork', reset);

  return {
    takeTrigger: () => {
      if (!attempt?.triggered) return false;
      attempt.triggered = false;
      return true;
    },
  };
}
