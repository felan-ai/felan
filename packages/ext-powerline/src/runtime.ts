import { associateExtensionConfig, resolveExtensionConfigs, type InferExtensionConfig, type ExtensionContext, type FelanExtension } from '@felan-ai/agent-core';
import { POWERLINE_CONFIG } from './config.js';
import { GitCache } from './git.js';
import { getUsageTotals } from './usage.js';
import type { SessionUsageTotals, PowerlineSegment } from './data.js';
import { createSubscriptionController, prioritizeWindowsForModel, type SubscriptionUsageHost, type SubscriptionUsageStore } from './subscription.js';
import { createSavingsController, type SavingsUsageHost } from './savings.js';
import { parsePowerlineData, type PowerlineData } from './data.js';
import { createGenericPowerlinePresentation } from './generic.js';

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
}

export function createPowerlineRuntimeExtension(subscriptionHost?: SubscriptionUsageHost, options: PowerlineRuntimeOptions = {}, presentationHost?: PowerlinePresentationHost): FelanExtension {
  const extension: FelanExtension = pi => {
    const host = presentationHost ?? createGenericPowerlinePresentation(pi.ui);
    const config = resolveExtensionConfigs([POWERLINE_CONFIG], [{ extensionId: 'powerline', values: pi.config ?? {}, source: 'Powerline configuration' }]).get('powerline') as InferExtensionConfig<typeof POWERLINE_CONFIG>;
    let context: ExtensionContext | undefined;
    let generation = 0;
    let disposed = false;
    let failure: unknown;
    let draining = Promise.resolve();
    let active: { refresh(force?: boolean): void; observeProviderResponse(headers: Record<string, string>): void; stop(): void; pending: Set<Promise<void>> } | undefined;

    function stop(): void {
      generation++;
      const old = active; active = undefined;
      if (!old) return;
      try { old.stop(); } catch (error) { failure ??= error; }
      draining = Promise.all([draining, ...old.pending]).then(async () => {
        const results = await Promise.allSettled([
          Promise.resolve().then(() => subscriptionHost?.settle?.()),
          Promise.resolve().then(() => options.additionalSessionUsageHost?.settle?.()),
          Promise.resolve().then(() => host.settle?.()),
        ]);
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (errors.length) throw new AggregateError(errors, 'Powerline cleanup failed.');
      }).catch(error => {
        failure ??= error; pi.runtime.logger.error({ component: 'powerline' }, 'Powerline cleanup failed.');
      });
      try { host.clear(); } catch (error) { failure ??= error; }
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
      const git = new GitCache(pi, context!.cwd, Date.now, { showWorkingTree: config.showWorkingTree, showStashCount: config.showStashCount });
      let redrawQueued = false;
      const changed = () => { if (!redrawQueued) { redrawQueued = true; queueMicrotask(() => { redrawQueued = false; redraw(); }); } };
      const subscription = createSubscriptionController(subscriptionHost, changed, options.subscriptionStore);
      const savings = options.savingsHost ? createSavingsController(options.savingsHost, changed) : undefined;
      const additional = options.additionalSessionUsageHost;
      let unsubscribeAdditional: (() => void) | undefined;
      const period = config.periodDays;
      function track(promise: Promise<void>): void {
        const tracked = promise.catch(fail).finally(() => pending.delete(tracked));
        pending.add(tracked);
      }
      function redraw(): void {
        if (!alive || disposed || !context) return;
        try {
          const current = context;
          const additionalUsage = additional?.getUsage();
          const session = getUsageTotals(current, additionalUsage);
          const contextUsage = current.getContextUsage();
          const segments: PowerlineSegment[] = [
            { name: 'directory', colorKey: 'directory', values: { cwd: plain(current.cwd) } },
            { name: 'model', colorKey: 'model', values: { id: plain(current.model?.id ?? 'no-model'), provider: plain(current.model?.provider ?? ''),
              reasoning: current.model?.reasoning ?? false, ...(current.thinkingLevel ? { thinkingLevel: current.thinkingLevel } : {}),
              providerCount: new Set(current.modelRegistry.getAvailable().map(model => model.provider)).size } },
            { name: 'session', colorKey: 'session', values: session },
          ];
          const details = git.get();
          if (details) {
            const { refreshedAt: _refreshedAt, ...values } = details;
            segments.push({ name: 'git', colorKey: 'git', values });
          }
          if (subscriptionHost || subscription.state.provider) {
            const state = subscription.state;
            const windows = prioritizeWindowsForModel(state.usage?.windows ?? [], current.model)
              .filter(window => state.provider !== 'codex' || (window.label.match(/(?:^| )(5h|\d+h|Day|Week)$/)?.[1] ?? window.label) === window.label)
              .slice(0, config.maxWindows);
            const error = state.usage?.error;
            segments.push({ name: 'subscription', colorKey: error ? 'warning' : 'subscription', values: { loading: state.loading, windows,
              ...(state.provider ? { provider: state.provider } : {}), ...(error ? { error: { code: error.code, ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }) } } : {}) } });
          }
          if (savings) segments.push({ name: 'savings', colorKey: 'savings', values: { ...savings.state, periodDays: period } });
          const contextWindow = contextUsage?.contextWindow ?? current.model?.contextWindow;
          if (contextWindow) segments.push({ name: 'context', colorKey: 'context', values: { tokens: contextUsage?.tokens ?? null, percent: contextUsage?.percent ?? null, contextWindow } });
          if (options.felanVersion) segments.push({ name: 'version', colorKey: 'version', values: { version: plain(options.felanVersion) } });
          const data = parsePowerlineData({ segments: sanitizeValues(segments) });
          const snapshot: PowerlineRuntimeSnapshot = { session, context: contextUsage };
          const next = JSON.stringify([data, snapshot]);
          dirty = signature !== next;
          if (dirty && host.publish(data, snapshot)) {
            signature = next; dirty = false;
            if (host.settle) track(host.settle());
          }
        } catch (error) { fail(error); }
      }
      function refresh(force = false): void {
        if (!alive || !context) return;
        track(git.refresh().then(redraw));
        track(subscription.refresh(context.model, { force }));
        if (savings) track(savings.refresh(period));
        redraw();
      }
      const timer = setInterval(() => refresh(), 60_000);
      const retry = setInterval(() => { if (dirty) redraw(); }, 1_000);
      timer.unref?.(); retry.unref?.();
      active = { refresh, pending, observeProviderResponse(headers) { subscription.observeProviderResponse(context?.model, headers); }, stop() {
        alive = false; clearInterval(timer); clearInterval(retry);
        for (const cleanup of [unsubscribeAdditional, () => git?.dispose(), () => subscription.clear(), () => savings?.clear()]) {
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
    pi.on('after_provider_response', (event, ctx) => { context = ctx; active?.observeProviderResponse(event.headers); });
    pi.on('session_shutdown', async () => {
      disposed = true;
      stop(); await draining;
      if (failure) throw failure;
    });
  };
  associateExtensionConfig(extension, POWERLINE_CONFIG);
  return extension;
}

export { POWERLINE_CONFIG } from './config.js';
export * from './subscription.js';
export * from './savings.js';
export type { SessionUsageTotals } from './data.js';
export default createPowerlineRuntimeExtension();

function plain(value: string): string { return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '').replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' '); }
function sanitizeValues(value: unknown): unknown {
  if (typeof value === 'string') return plain(value);
  if (Array.isArray(value)) return value.map(sanitizeValues);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeValues(entry)]));
  return value;
}
