import type { ExtensionContext, FelanExtension } from '@felan-ai/agent-core';
import { configFromFlags, loadPowerlineConfig, registerPowerlineFlags } from './config.js';
import { PowerlineFooter } from './footer.js';
import {
  createSubscriptionController,
  type SubscriptionRefreshOptions,
  type SubscriptionState,
  type SubscriptionUsageHost,
} from './subscription.js';

const SUBSCRIPTION_REFRESH_TIMER_MS = 60_000;

export function createPowerlineExtension(subscriptionHost?: SubscriptionUsageHost): FelanExtension {
  return (pi) => {
    let footer: PowerlineFooter | undefined;
    let subscriptionContext: ExtensionContext | undefined;
    let subscriptionTimer: ReturnType<typeof setInterval> | undefined;
    const emptySubscription: SubscriptionState = { loading: false };
    const loadedConfig = loadPowerlineConfig(pi.agentDir);
    const subscription = subscriptionHost && loadedConfig.config.display.lines.some(
      (line) => line.segments.subscription?.enabled,
    )
      ? createSubscriptionController(subscriptionHost, redraw)
      : undefined;

    registerPowerlineFlags(pi, loadedConfig.config);

    function installFooter(ctx: ExtensionContext): void {
      if (ctx.mode !== 'tui') return;
      if (loadedConfig.warning) ctx.ui.notify(loadedConfig.warning, 'warning');
      footer?.dispose();
      ctx.ui.setFooter((tui, _theme, footerData) => {
        footer = new PowerlineFooter({
          pi,
          ctx,
          tui,
          footerData,
          config: configFromFlags(pi, loadedConfig.config),
          subscription: subscription?.state ?? emptySubscription,
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

    pi.on('session_start', (_event, ctx) => {
      subscriptionContext = ctx;
      installFooter(ctx);
      startSubscriptionTimer(ctx);
      refreshSubscription(ctx, { allowStaleCache: true });
    });
    pi.on('session_shutdown', (_event, ctx) => {
      clearSubscriptionTimer();
      subscriptionContext = undefined;
      footer?.dispose();
      footer = undefined;
      subscription?.clear();
      if (ctx.mode === 'tui') ctx.ui.setFooter(undefined);
    });

    pi.on('agent_start', redraw);
    pi.on('agent_end', redraw);
    pi.on('turn_end', (_event, ctx) => {
      subscriptionContext = ctx;
      refreshSubscription(ctx);
      redraw();
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

export default powerlineExtension;
export {
  POWERLINE_CONFIG_FILENAME,
  POWERLINE_FLAGS,
  configFromFlags,
  loadPowerlineConfig,
} from './config.js';
export { PowerlineFooter, renderFooterLine, renderStyledSegments } from './footer.js';
export { GitCache, formatAge, parseGitStatus, runGit } from './git.js';
export { formatTokens, renderSegments, sanitizePlainText } from './segments.js';
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
