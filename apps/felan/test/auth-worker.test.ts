import { expect, it } from 'vitest';
import type { ModelRuntime } from '@felan-ai/agent-core';
import { authenticateProvider } from '../src/providers/setup/auth-worker.js';
import type { AuthWorkerOutput } from '../src/providers/setup/auth-wire.js';

it('masks API-key prompts and redacts known secrets from provider messages', async () => {
  const events: AuthWorkerOutput[] = []; const secret = 'synthetic-private-api-key';
  const models = { login: async (_provider: string, _method: string, interaction: Parameters<ModelRuntime['login']>[2]) => {
    expect(await interaction.prompt({ type: 'secret', message: 'Enter key' })).toBe(secret);
    interaction.notify({ type: 'info', message: `Configured ${secret}` });
  } } as unknown as ModelRuntime;
  await authenticateProvider({ kind: 'start', agentDir: '/fixture', provider: 'fixture', method: 'api_key' }, {
    signal: new AbortController().signal, createModels: async () => models, emit: event => events.push(event), prompt: async () => secret,
  });
  expect(events[0]).toMatchObject({ kind: 'prompt', prompt: { secret: true } });
  expect(JSON.stringify(events)).not.toContain(secret);
  expect(events.filter(event => event.kind === 'done')).toHaveLength(1);
});

it('dismisses a provider-cancelled prompt without continuing a stale input', async () => {
  const events: AuthWorkerOutput[] = []; const prompt = new AbortController();
  const models = { login: async (_provider: string, _method: string, interaction: Parameters<ModelRuntime['login']>[2]) => {
    const pending = interaction.prompt({ type: 'manual_code', message: 'Code', signal: prompt.signal });
    prompt.abort(); await pending.catch(() => {});
  } } as unknown as ModelRuntime;
  await authenticateProvider({ kind: 'start', agentDir: '/fixture', provider: 'fixture', method: 'oauth' }, {
    signal: new AbortController().signal, createModels: async () => models, emit: event => events.push(event),
    prompt: async (_value, signal) => new Promise((_resolve, reject) => {
      const abort = () => reject(new Error('cancelled')); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    }),
  });
  expect(events.map(event => event.kind)).toEqual(['prompt', 'dismiss', 'done']);
});
