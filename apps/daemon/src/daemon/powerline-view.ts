import { createPowerlineRuntimeExtension, type PowerlineExtensionFactory } from '@felan-ai/ext-powerline/runtime';
import { POWERLINE_PRESENTER } from '@felan-ai/ext-powerline/view';
import type { Interaction, Presentation } from '@felan-ai/session-protocol';
import type { InteractionBroker } from './broker.js';
import { ControlStoreError } from './control-state.js';

export function createBrokerPowerlineFactory(options: {
  broker: InteractionBroker;
  scope: Extract<Interaction['scope'], { kind: 'session' }>;
  signal: AbortSignal;
  ready(): boolean;
  statuses(): ReadonlyMap<string, string>;
  subscribe(listener: () => void): () => void;
  present(value: Presentation | { id: string; remove: true }): void;
}): PowerlineExtensionFactory {
  return (subscription, config) => {
    let pending: Presentation | { id: string; remove: true } | undefined;
    let committed = '';
    let failure: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listeners = new Set<() => void>();
    const notify = () => { for (const listener of [...listeners]) listener(); };
    const stopTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
    options.signal.addEventListener('abort', () => { stopTimer(); pending = undefined; notify(); listeners.clear(); }, { once: true });
    function flush(): boolean {
      if (failure) throw failure;
      if (!pending || options.signal.aborted) return true;
      const key = JSON.stringify(pending);
      if (key === committed) { pending = undefined; stopTimer(); return true; }
      try {
        options.present(pending); committed = key; pending = undefined; stopTimer(); return true;
      } catch (error) {
        if (!(error instanceof ControlStoreError) || error.code !== 'request_capacity') throw error;
        timer ??= setTimeout(() => {
          timer = undefined;
          try { flush(); } catch (error) { failure = error; notify(); }
        }, 1_000);
        timer.unref(); return false;
      }
    }
    return createPowerlineRuntimeExtension(subscription, config, {
      available() {
        if (failure) throw failure;
        return !options.signal.aborted && options.ready() && options.broker.canPresent({ kind: 'custom', presenter: POWERLINE_PRESENTER, data: {} }, options.scope, 'tui');
      },
      subscribe(listener) {
        listeners.add(listener);
        const offClients = options.broker.subscribeClients(listener); const offStatus = options.subscribe(listener);
        return () => { listeners.delete(listener); offClients(); offStatus(); };
      },
      statuses: options.statuses,
      publish(data) {
        pending = { id: POWERLINE_PRESENTER.id, kind: 'custom', presenter: POWERLINE_PRESENTER, data: {
          ...data, lines: data.lines.map(line => line.map(segment => ({ ...segment }))),
        } };
        return flush();
      },
      clear() { if (!options.signal.aborted) { pending = { id: POWERLINE_PRESENTER.id, remove: true }; flush(); } },
    });
  };
}
