import { associateExtensionConfig, type ExtensionContext, type FelanExtension } from '@felan-ai/agent-core';
import { powerlineConfigFromSettings, POWERLINE_CONFIG } from './config.js';
import { PowerlineFooter, type FooterRowsRenderer } from './footer.js';
import {
  createSubscriptionController,
  type SubscriptionRefreshOptions,
  type SubscriptionState,
  type SubscriptionUsageHost,
} from './subscription.js';
import { createSavingsController, type SavingsController, type SavingsUsageHost } from './savings.js';
import type { SessionUsageTotals } from './segments.js';

const SUBSCRIPTION_REFRESH_TIMER_MS = 60_000;

export interface AdditionalSessionUsageHost {
  getUsage(): SessionUsageTotals;
  subscribe(listener: () => void): () => void;
}

export interface PowerlineExtensionOptions {
  readonly footerRows?: FooterRowsRenderer;
  readonly savingsHost?: SavingsUsageHost;
  readonly additionalSessionUsageHost?: AdditionalSessionUsageHost;
}

export function createPowerlineExtension(
  subscriptionHost?: SubscriptionUsageHost,
  options: PowerlineExtensionOptions = {},
): FelanExtension {
  return (pi) => {
    let footer: PowerlineFooter | undefined;
    let subscriptionContext: ExtensionContext | undefined;
    let subscriptionTimer: ReturnType<typeof setInterval> | undefined;
    let savingsTimer: ReturnType<typeof setInterval> | undefined;
    let unsubscribeAdditionalSessionUsage: (() => void) | undefined;
    const emptySubscription: SubscriptionState = { loading: false };
    const config = powerlineConfigFromSettings(pi.config ?? {});
    const subscription = subscriptionHost && config.display.lines.some(
      (line) => line.segments.subscription?.enabled,
    )
      ? createSubscriptionController(subscriptionHost, redraw)
      : undefined;
    const savings = options.savingsHost && config.display.lines.some((line) => line.segments.savings?.enabled)
      ? createSavingsController(options.savingsHost, redraw)
      : undefined;
    const additionalSessionUsageHost = options.additionalSessionUsageHost
      && config.display.lines.some((line) => line.segments.session?.enabled)
      ? options.additionalSessionUsageHost
      : undefined;
    const emptySavings = { loading: false } as const;

    function installFooter(ctx: ExtensionContext): void {
      if (ctx.mode !== 'tui') return;
      footer?.dispose();
      ctx.ui.setFooter((tui, _theme, footerData) => {
        footer = new PowerlineFooter({
          pi,
          ctx,
          tui,
          footerData,
          config,
          subscription: subscription?.state ?? emptySubscription,
          savings: () => savings?.state ?? emptySavings,
          ...(additionalSessionUsageHost === undefined
            ? {}
            : { additionalSessionUsage: () => additionalSessionUsageHost.getUsage() }),
          ...(options.footerRows === undefined ? {} : { footerRows: options.footerRows }),
        });
        return footer;
      });
    }

    function redraw(): void {
      footer?.invalidate();
    }

    function refreshSubscription(
      ctx: ExtensionContext,
      options?: SubscriptionRefreshOptions,
    ): void {
      if (!subscription || ctx.mode !== 'tui') return;
      void subscription.refresh(ctx.model, options).catch(redraw);
    }

    function startSubscriptionTimer(ctx: ExtensionContext): void {
      clearSubscriptionTimer();
      if (!subscription || ctx.mode !== 'tui') return;
      subscriptionTimer = setInterval(() => {
        if (subscriptionContext) refreshSubscription(subscriptionContext);
      }, SUBSCRIPTION_REFRESH_TIMER_MS);
    }

    function clearSubscriptionTimer(): void {
      if (!subscriptionTimer) return;
      clearInterval(subscriptionTimer);
      subscriptionTimer = undefined;
    }
    function subscribeAdditionalSessionUsage(ctx: ExtensionContext): void {
      unsubscribeAdditionalSessionUsage?.();
      unsubscribeAdditionalSessionUsage = undefined;
      if (ctx.mode !== 'tui' || !additionalSessionUsageHost) return;
      unsubscribeAdditionalSessionUsage = additionalSessionUsageHost.subscribe(redraw);
    }
    function startSavingsTimer(): void {
      if (!savings) return;
      clearInterval(savingsTimer);
      savingsTimer = setInterval(() => refreshSavings(), 60_000);
    }
    function refreshSavings(): void {
      if (!savings) return;
      const segment = config.display.lines.flatMap((line) => line.segments.savings ? [line.segments.savings] : [])[0];
      void savings.refresh(segment?.periodDays ?? 7);
    }

    pi.on('session_start', (_event, ctx) => {
      subscriptionContext = ctx;
      installFooter(ctx);
      subscribeAdditionalSessionUsage(ctx);
      startSubscriptionTimer(ctx);
      refreshSubscription(ctx, { allowStaleCache: true });
      startSavingsTimer();
      refreshSavings();
    });
    pi.on('session_shutdown', (_event, ctx) => {
      clearSubscriptionTimer();
      unsubscribeAdditionalSessionUsage?.();
      unsubscribeAdditionalSessionUsage = undefined;
      clearInterval(savingsTimer);
      savingsTimer = undefined;
      subscriptionContext = undefined;
      footer?.dispose();
      footer = undefined;
      subscription?.clear();
      savings?.clear();
      if (ctx.mode === 'tui') ctx.ui.setFooter(undefined);
    });

    pi.on('agent_start', redraw);
    pi.on('agent_end', redraw);
    pi.on('turn_end', (_event, ctx) => {
      subscriptionContext = ctx;
      refreshSubscription(ctx);
      redraw();
      refreshSavings();
    });
    pi.on('tool_execution_end', redraw);
    pi.on('session_compact', redraw);
    pi.on('session_tree', redraw);
    pi.on('model_select', (_event, ctx) => {
      subscriptionContext = ctx;
      refreshSubscription(ctx, { force: true, resetProvider: true });
      redraw();
    });
    pi.on('thinking_level_select', redraw);
  };
}

const powerlineExtension = createPowerlineExtension();

associateExtensionConfig(powerlineExtension, POWERLINE_CONFIG);

export default powerlineExtension;
export {
  DEFAULT_CONFIG,
  POWERLINE_CONFIG,
  powerlineConfigFromSettings,
} from './config.js';
export { PowerlineFooter, renderFooterLine, renderStyledSegments } from './footer.js';
export type { FooterRowsRenderer } from './footer.js';
export { createSavingsController } from './savings.js';
export type { SavingsController, SavingsState, SavingsUsageHost, SavingsUsageHostRequest, SavingsUsageHostResult } from './savings.js';
export { GitCache, formatAge, parseGitStatus, runGit } from './git.js';
export { formatTokens, renderSegments, sanitizePlainText } from './segments.js';
export type { SessionUsageTotals } from './segments.js';
export {
  createSubscriptionController,
  detectSubscriptionProvider,
  formatReset,
  normalizeTokens,
  parseUsageSnapshot,
  prioritizeWindowsForModel,
} from './subscription.js';
export type {
  RateWindow,
  SubscriptionController,
  SubscriptionProviderName,
  SubscriptionRefreshOptions,
  SubscriptionState,
  SubscriptionUsageHost,
  SubscriptionUsageHostRequest,
  SubscriptionUsageHostResult,
  UsageError,
  UsageErrorCode,
  UsageSnapshot,
} from './subscription.js';
