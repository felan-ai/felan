import { associateExtensionConfig, type ExtensionContext, type FelanExtension } from '@felan-ai/agent-core';
import { POWERLINE_CONFIG, powerlineConfigFromSettings } from './config.js';
import { GitCache } from './git.js';
import { getUsageTotals, renderSegments, sanitizePlainText, type SessionUsageTotals } from './segments.js';
import { createSubscriptionController, type SubscriptionUsageHost, type SubscriptionUsageStore } from './subscription.js';
import { createSavingsController, type SavingsUsageHost } from './savings.js';
import { getSymbols } from './symbols.js';
import { powerlineData, type PowerlineData } from './data.js';

export interface PowerlinePresentationHost {
  publish(data: PowerlineData, snapshot?: PowerlineRuntimeSnapshot): boolean;
  clear(): void;
  settle?(): Promise<void>;
}
export interface PowerlineRuntimeSnapshot {
  readonly session?: SessionUsageTotals;
  readonly context?: ReturnType<ExtensionContext['getContextUsage']>;
}
export interface PowerlineRuntimeOptions {
  readonly felanVersion?: string;
  readonly savingsHost?: SavingsUsageHost;
  readonly additionalSessionUsageHost?: { getUsage(): SessionUsageTotals; settle?(): Promise<void>; subscribe(listener: () => void): () => void };
  readonly subscriptionStore?: SubscriptionUsageStore;
  readonly footerRows?: (width: number) => readonly string[];
}

export function createPowerlineRuntimeExtension(subscriptionHost?: SubscriptionUsageHost, options: PowerlineRuntimeOptions = {}, host?: PowerlinePresentationHost): FelanExtension {
  const extension: FelanExtension = pi => {
    if (!host) return;
    const config = powerlineConfigFromSettings(pi.config ?? {});
    const enabled = (name: 'subscription' | 'savings' | 'session' | 'git' | 'context') => config.display.lines.some(line => line.segments[name]?.enabled);
    let context: ExtensionContext | undefined;
    let generation = 0;
    let disposed = false;
    let failure: unknown;
    let draining = Promise.resolve();
    let active: { refresh(force?: boolean): void; stop(): void; pending: Set<Promise<void>> } | undefined;

    function stop(): void {
      generation++;
      const old = active; active = undefined;
      if (!old) return;
      try { old.stop(); } catch (error) { failure ??= error; }
      draining = Promise.all([draining, ...old.pending]).then(async () => {
        const results = await Promise.allSettled([
          Promise.resolve().then(() => subscriptionHost?.settle?.()),
          Promise.resolve().then(() => options.additionalSessionUsageHost?.settle?.()),
          Promise.resolve().then(() => host!.settle?.()),
        ]);
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (errors.length) throw new AggregateError(errors, 'Powerline cleanup failed.');
      }).catch(error => {
        failure ??= error; pi.runtime.logger.error({ component: 'powerline' }, 'Powerline cleanup failed.');
      });
      try { host!.clear(); } catch (error) { failure ??= error; }
    }
    function fail(error: unknown): void {
      failure ??= error; stop();
      pi.runtime.logger.error({ component: 'powerline' }, 'Powerline data projection failed.');
    }
    function reconcile(force = false): void {
      if (failure) throw failure;
      if (disposed || !context) { stop(); return; }
      if (active) { active.refresh(force); return; }
      const expected = ++generation;
      void draining.then(() => {
        if (disposed || failure || expected !== generation || !context) return;
        start();
      }).catch(fail);
    }
    function start(): void {
      let alive = true;
      let signature = '';
      let dirty = true;
      const pending = new Set<Promise<void>>();
      const git = enabled('git') ? new GitCache(pi, context!.cwd) : undefined;
      let redrawQueued = false;
      const changed = () => { if (!redrawQueued) { redrawQueued = true; queueMicrotask(() => { redrawQueued = false; redraw(); }); } };
      const subscription = subscriptionHost && enabled('subscription') ? createSubscriptionController(subscriptionHost, changed, options.subscriptionStore) : undefined;
      const savings = options.savingsHost && enabled('savings') ? createSavingsController(options.savingsHost, changed) : undefined;
      const additional = enabled('session') ? options.additionalSessionUsageHost : undefined;
      let unsubscribeAdditional: (() => void) | undefined;
      const period = config.display.lines.flatMap(line => line.segments.savings ? [line.segments.savings.periodDays ?? 7] : [])[0] ?? 7;
      function track(promise: Promise<void>): void {
        const tracked = promise.catch(fail).finally(() => pending.delete(tracked));
        pending.add(tracked);
      }
      function redraw(): void {
        if (!alive || disposed || !context) return;
        try {
          const current = context;
          const additionalUsage = additional?.getUsage();
          const lines = config.display.lines.map(line => renderSegments(line, {
            ctx: current, symbols: getSymbols(config.display.charset),
            footerData: { getGitBranch: () => git?.get()?.branch ?? null, getExtensionStatuses: () => new Map(),
              getAvailableProviderCount: () => new Set(current.modelRegistry.getAvailable().map(model => model.provider)).size,
              onBranchChange: () => () => {} },
            ...(options.felanVersion === undefined ? {} : { felanVersion: options.felanVersion }),
            ...(git?.get() === undefined ? {} : { gitDetails: git.get()! }),
            subscription: subscription?.state ?? { loading: false },
            ...(savings === undefined ? {} : { savings: savings.state }),
            ...(additionalUsage === undefined ? {} : { additionalSessionUsage: additionalUsage }),
          }).map(segment => ({ ...segment, text: sanitizePlainText(segment.text).replace(/[\u007f-\u009f]/gu, ' ') })));
          const data = powerlineData(config, lines);
          const snapshot: PowerlineRuntimeSnapshot = {
            ...(enabled('session') ? { session: getUsageTotals(current, additionalUsage) } : {}),
            ...(enabled('context') ? { context: current.getContextUsage() } : {}),
          };
          const next = JSON.stringify([data, snapshot]);
          dirty = signature !== next;
          if (dirty && host!.publish(data, snapshot)) {
            signature = next; dirty = false;
            if (host!.settle) track(host!.settle());
          }
        } catch (error) { fail(error); }
      }
      function refresh(force = false): void {
        if (!alive || !context) return;
        if (git) track(git.refresh().then(redraw));
        if (subscription) track(subscription.refresh(context.model, { force }));
        if (savings) track(savings.refresh(period));
        redraw();
      }
      const timer = setInterval(() => refresh(), 60_000);
      const retry = setInterval(() => { if (dirty) redraw(); }, 1_000);
      timer.unref?.(); retry.unref?.();
      active = { refresh, pending, stop() {
        alive = false; clearInterval(timer); clearInterval(retry);
        for (const cleanup of [unsubscribeAdditional, () => git?.dispose(), () => subscription?.clear(), () => savings?.clear()]) {
          try { cleanup?.(); } catch (error) { failure ??= error; }
        }
      } };
      unsubscribeAdditional = additional?.subscribe(changed);
      if (failure) { stop(); return; }
      refresh();
    }
    const update = (_event: unknown, ctx: ExtensionContext) => { context = ctx; reconcile(); };
    pi.on('session_start', update);
    pi.on('agent_start', update); pi.on('agent_end', update); pi.on('turn_end', update);
    pi.on('tool_execution_end', update); pi.on('session_compact', update); pi.on('session_tree', update); pi.on('thinking_level_select', update);
    pi.on('model_select', (_event, ctx) => { context = ctx; reconcile(true); });
    pi.on('session_shutdown', async () => {
      disposed = true;
      stop(); await draining;
      if (failure) throw failure;
    });
  };
  associateExtensionConfig(extension, POWERLINE_CONFIG);
  return extension;
}

export { POWERLINE_CONFIG, powerlineConfigFromSettings } from './config.js';
export * from './subscription.js';
export * from './savings.js';
export type { SessionUsageTotals } from './segments.js';
export default createPowerlineRuntimeExtension();
