import { SESSIONS_HISTORY_SERVICE, SESSIONS_SERVICE, SessionsServiceError, createReadOnlySessionsService, HOST_WORKERS_SERVICE, RUNTIME_LIFETIME_SERVICE, type RuntimeLifecycle, type SessionsService } from '@felan-ai/agent-core';
import { defineServiceProvider } from '@felan-ai/daemon/provider';

export default defineServiceProvider({
  scope: 'session',
  provides: [SESSIONS_SERVICE, SESSIONS_HISTORY_SERVICE, HOST_WORKERS_SERVICE, RUNTIME_LIFETIME_SERVICE],
  async create(context) {
    const port = context.sessions;
    if (!port || port.current.id !== context.sessionId || port.current.root !== context.rootSessionId) throw new SessionsServiceError('inaccessible');
    let state: 'created' | 'active' | 'settling' | 'disposed' = 'created';
    const lifetime = new AbortController();
    const options = <T extends { readonly signal?: AbortSignal }>(value?: T) => ({ ...value,
      signal: AbortSignal.any([context.signal, lifetime.signal, ...(value?.signal ? [value.signal] : [])]) });
    const work = new Set<Promise<unknown>>();
    const subscriptions = new Set<() => void>();
    const lifecycles = new Set<RuntimeLifecycle>();
    const check = () => {
      if (state !== 'active' || context.signal.aborted) throw new SessionsServiceError('inaccessible');
    };
    const call = <T>(operation: () => Promise<T>): Promise<T> => {
      let result: Promise<T>;
      try { check(); result = Promise.resolve(operation()); } catch (error) { return Promise.reject(error); }
      work.add(result);
      void result.then(() => work.delete(result), () => work.delete(result));
      return result;
    };
    const release = () => { for (const dispose of [...subscriptions]) dispose(); subscriptions.clear(); };
    const drain = async () => { while (work.size) await Promise.allSettled([...work]); };
    const value: SessionsService = Object.freeze({
      current: Object.freeze({ ...port.current }),
      list: (filter, request) => call(() => port.list(filter, options(request))),
      history: (id, request) => call(() => port.history(id, options(request))),
      checkpoint: (id, request) => call(() => port.checkpoint(id, options(request))),
      setTitleIfMissing: (title, id, request) => call(() => port.setTitleIfMissing(title, id, options(request))),
      create: (input, request) => call(() => port.create(input, options(request))),
      executions: request => call(() => port.executions(options(request))),
      execution: (id, request) => call(() => port.execution(id, options(request))),
      steer: (id, message, request) => call(() => port.steer(id, message, options(request))),
      cancel: (id, reason, request) => call(() => port.cancel(id, reason, options(request))),
      subscribe(listener) {
        check();
        const stop = port.subscribe(listener);
        const dispose = () => { if (!subscriptions.delete(dispose)) return; stop(); };
        subscriptions.add(dispose); return dispose;
      },
    } satisfies SessionsService);
    const workers: import('@felan-ai/agent-core').HostWorkerLauncher = input => call(() => {
      if (!context.openWorker) throw new SessionsServiceError('unsupported');
      return context.openWorker({ ...input, signal: options(input).signal });
    });
    const runtimeLifetime: import('@felan-ai/agent-core').RuntimeLifetime = {
      register(lifecycle) {
        if (state === 'settling' || state === 'disposed' || context.signal.aborted) throw new SessionsServiceError('inaccessible');
        lifecycles.add(lifecycle);
        return () => { lifecycles.delete(lifecycle); };
      },
    };
    return {
      implementations: [{ contract: SESSIONS_SERVICE, value }, { contract: SESSIONS_HISTORY_SERVICE, value: createReadOnlySessionsService(value) },
        { contract: RUNTIME_LIFETIME_SERVICE, value: runtimeLifetime },
        ...(context.openWorker ? [{ contract: HOST_WORKERS_SERVICE, value: workers }] : [])],
      busy: () => [...lifecycles].some(lifecycle => lifecycle.busy()),
      async activate() { if (state !== 'created' || context.signal.aborted) throw new SessionsServiceError('inaccessible'); state = 'active'; },
      async settle(mode) {
        await Promise.all([...lifecycles].map(lifecycle => lifecycle.settle(mode)));
        state = 'settling'; if (mode === 'force') lifetime.abort(); release(); await drain();
      },
      async dispose() {
        state = 'disposed'; lifetime.abort(); release();
        await Promise.all([...lifecycles].map(lifecycle => lifecycle.dispose()));
        lifecycles.clear(); await drain();
      },
    };
  },
});
