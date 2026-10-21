import { RUNTIME_DEPENDENCIES_SERVICE, type RuntimeDependencyInstallResult } from '@felan-ai/agent-core';
import { defineServiceProvider } from '@felan-ai/daemon/provider';

const supported = new Set(['markitdown', 'rtk', 'codebase-memory', 'claude-code']);

export default defineServiceProvider({
  scope: 'session', provides: [RUNTIME_DEPENDENCIES_SERVICE],
  async create(context) {
    const lifetime = new AbortController();
    const pending = new Set<Promise<RuntimeDependencyInstallResult>>();
    let closing = false;
    const settle = async () => { while (pending.size) await Promise.allSettled([...pending]); };
    return { implementations: [{ contract: RUNTIME_DEPENDENCIES_SERVICE, value: {
      install: async (request: { readonly id: string }, options?: { readonly signal?: AbortSignal }) => {
        if (closing || !supported.has(request?.id) || !context.runtimeDependencies) return { status: 'unavailable' as const, message: 'Dependency installation is unavailable.' };
        const signal = AbortSignal.any([context.signal, lifetime.signal, ...(options?.signal ? [options.signal] : [])]);
        const operation = context.runtimeDependencies.install({ id: request.id }, { signal });
        pending.add(operation);
        try { return await operation; } finally { pending.delete(operation); }
      },
    } }], async settle(mode) { closing = true; if (mode === 'force') lifetime.abort(); await settle(); },
    async dispose() { closing = true; lifetime.abort(); await settle(); } };
  },
});
