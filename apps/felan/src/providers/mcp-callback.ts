import { defineServiceProvider } from '@felan-ai/daemon/provider';
import { MCP_OAUTH_CALLBACK_SERVICE, type McpOAuthCallbackService, type OAuthCallbackReservation } from '@felan-ai/ext-mcp/service';
import { reserveOAuthCallback } from './mcp/callback-server.js';

export default defineServiceProvider({
  scope: 'session',
  provides: [MCP_OAUTH_CALLBACK_SERVICE],
  async create(context) {
    const lifetime = new AbortController();
    const pending = new Set<Promise<unknown>>();
    const reservations = new Set<OAuthCallbackReservation>();
    let active = false;
    const value: McpOAuthCallbackService = {
      async reserve(redirectUri, state, signal, timeoutMs) {
        if (!active) throw new Error('MCP callback service is unavailable.');
        const combined = AbortSignal.any([context.signal, lifetime.signal, signal]);
        combined.throwIfAborted();
        const operation = reserveOAuthCallback(redirectUri, state, combined, timeoutMs);
        pending.add(operation);
        try {
          const reservation = await operation;
          if (combined.aborted) { reservation.release(); combined.throwIfAborted(); }
          reservations.add(reservation);
          const release = () => { reservations.delete(reservation); reservation.release(); };
          void reservation.wait().then(release, release);
          return { ...reservation, release };
        } finally { pending.delete(operation); }
      },
    };
    const close = async () => {
      active = false;
      lifetime.abort();
      await Promise.allSettled([...pending]);
      for (const reservation of reservations) reservation.release();
      reservations.clear();
    };
    return {
      implementations: [{ contract: MCP_OAUTH_CALLBACK_SERVICE, value }],
      async activate() { context.signal.throwIfAborted(); lifetime.signal.throwIfAborted(); active = true; },
      settle: close,
      dispose: close,
    };
  },
});
