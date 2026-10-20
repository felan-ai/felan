import { expect, it, vi } from 'vitest';
import { PlatformClient, type RemoteSupabaseClient } from '../src/remote/platform.js';
import type { HostTokenProvider } from '../src/remote/token.js';
import type { RemoteCommandOutcome } from '@felan-ai/session-protocol';

it.each([{ session: '019a0000-0000-7000-8000-000000000001' }, { runId: 'run-id' }])('preserves accepted completion result %j at the RPC boundary', async result => {
  const id = '019a0000-0000-7000-8000-000000000002';
  const rpc = vi.fn(async (_name: string, _params?: Record<string, unknown>) => ({ data: null, error: null }));
  const source: HostTokenProvider = { token: async () => 'token', cachedToken: () => 'token', onChange: () => () => {}, current: () => ({
    host: { id, teamId: id, userId: id }, expiresAt: Date.now() + 60000, refreshAt: Date.now() + 30000,
    supabase: { url: 'https://database.example.test', publishableKey: 'key' },
  }) };
  const client = { rpc, realtime: { setAuth: async () => {} } } as unknown as RemoteSupabaseClient;
  const platform = await PlatformClient.connect(source, { clientFactory: () => client });
  const outcome = { v: 1, re: id, outcome: 'accepted', result } as RemoteCommandOutcome;
  await platform.complete(id, outcome);
  expect(rpc).toHaveBeenCalledWith('complete_session_command', { p_id: id, p_outcome: outcome });
  expect(rpc.mock.calls[0]?.[1]?.p_outcome).not.toBe(outcome);
  await platform.close();
});
