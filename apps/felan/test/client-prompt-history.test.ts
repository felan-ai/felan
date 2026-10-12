import { afterEach, expect, it, vi } from 'vitest';
import { bindFelanExtension, type AgentRuntime } from '@felan-ai/agent-core';
import { createPromptHistoryExtension } from '@felan-ai/ext-prompt-history';
import { PROMPT_HISTORY_PRESENTER, parsePromptHistoryFrame, parsePromptHistoryRequest, parsePromptHistoryText, type PromptHistoryViewChoice } from '@felan-ai/ext-prompt-history/view';
import { createRegistryInteractionBroker } from '../../daemon/src/daemon/broker.js';
import { createSessionExtensionUi, SESSION_UI_PRESENTERS } from '../../daemon/src/daemon/extension-ui.js';
import { DaemonConfiguration } from '../../daemon/src/daemon/configuration.js';
import { SessionServer } from '../../daemon/src/daemon/server.js';
import { serverFixture } from '../../daemon/test/fixtures/server.js';
import { SessionClient } from '../src/client/client.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

it('routes prompt history through the real server and resumes full-text delivery without model work', async () => {
  let broker!: ReturnType<typeof createRegistryInteractionBroker>; let bridge!: ReturnType<typeof createSessionExtensionUi>;
  let runtime!: AgentRuntime; let agentDir = ''; const model = vi.fn();
  const f = await serverFixture({ now: () => Date.now(), onStream: async () => { model(); }, extensionUi(context, registry) {
    runtime = context.runtime; agentDir = context.resources.agentDir;
    broker ??= createRegistryInteractionBroker(registry, { presenters: SESSION_UI_PRESENTERS });
    bridge = createSessionExtensionUi({ broker, scope: { kind: 'session', session: context.sessionManager.getSessionId(), root: context.rootSessionId } }); return bridge;
  }, extension(pi) {
    const extension = createPromptHistoryExtension({ listSessions: async () => [], readSession: async () => undefined }, bridge.promptHistory);
    const bound = bindFelanExtension('fixture-prompt-history', extension, runtime, agentDir);
    return typeof bound === 'function' ? bound(pi) : bound.factory(pi);
  } });
  const clients: SessionClient[] = []; let server: SessionServer | undefined;
  cleanups.push(async () => { for (const client of clients) client.close(); server?.close(); bridge.dispose(); await broker.drain(); await f.dispose(); });
  const prompt = 'large retained user prompt😀\n'.repeat(10000);
  f.root.runtime.session.sessionManager.appendMessage({ role: 'user', content: prompt, timestamp: Date.now() });
  const configuration = new DaemonConfiguration({ agentDir, definitions: [], assertCurrent: () => f.registry.assertAdmission() });
  server = new SessionServer({ registry: f.registry, configuration, models: f.root.runtime.session.modelRuntime, version: 'fixture', broker });
  bridge.activate(update => f.registry.projection(f.root.sessionId).setPresentation(update)); await server.start();
  const connect = async () => {
    const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
      expected: f.owner.identity, clientVersion: 'fixture', kind: 'tui', presenters: [PROMPT_HISTORY_PRESENTER], interactionKinds: ['custom'], requestTimeoutMs: 1000, retries: 0 });
    clients.push(client); await client.connect(); await client.attach(f.root.sessionId); return client;
  };
  const pending = () => f.store.snapshot().interactions.find(item => item.state === 'waiting' && item.request.kind === 'custom' && item.request.presenter.id === PROMPT_HISTORY_PRESENTER.id);
  let client = await connect();
  expect(await client.request('command.invoke', { name: 'prompt-history', arguments: '' }, { session: f.root.sessionId })).toMatchObject({ outcome: 'accepted' });
  await vi.waitFor(() => expect(pending()).toBeDefined()); const original = pending()!;
  client.close(); client = await connect();
  await vi.waitFor(() => expect(client.getAttachment(f.root.sessionId)?.state.snapshot?.interactions).toContainEqual(expect.objectContaining({ id: original.id })));
  let lastId = ''; const chunks: string[] = []; let complete = false; let resumedTransfer = false;
  for (let step = 0; step < 100 && !complete; step++) {
    await vi.waitFor(() => { expect(pending()).toBeDefined(); expect(pending()!.id).not.toBe(lastId); });
    const item = pending()!; lastId = item.id; if (item.request.kind !== 'custom') throw new Error();
    const request = parsePromptHistoryRequest(item.request.data); let choice!: PromptHistoryViewChoice;
    if (request.kind === 'text' && request.index === 1 && !resumedTransfer) {
      client.close(); client = await connect(); resumedTransfer = true;
      await vi.waitFor(() => expect(client.getAttachment(f.root.sessionId)?.state.snapshot?.interactions).toContainEqual(expect.objectContaining({ id: item.id })));
    }
    await vi.waitFor(() => {
      const frame = client.getAttachment(f.root.sessionId)?.state.snapshot?.presentation.find(value => value.id === `prompt-history:${request.viewId}`);
      expect(frame?.kind).toBe('custom'); if (frame?.kind !== 'custom') return;
      if (request.kind === 'browse') {
        const data = parsePromptHistoryFrame(frame.data); expect(data.loading).toBe(false); expect(data.items.length).toBe(1);
        expect(data.items[0]!.text.endsWith('…')).toBe(true); choice = { action: 'choose', id: data.items[0]!.id };
      } else {
        const data = parsePromptHistoryText(frame.data); expect(data.generation).toBe(request.generation); expect(data.index).toBe(request.index);
        chunks[request.index] = data.text;
        complete = request.index === request.chunks - 1;
        choice = complete ? { action: 'insert' } : { action: 'chunk', index: request.index + 1 };
      }
    });
    expect(await client.request('interaction.answer', { interactionId: item.id,
      answer: { kind: 'custom', presenter: PROMPT_HISTORY_PRESENTER, data: { ...choice, viewId: request.viewId, generation: request.generation } } }, { session: f.root.sessionId })).toMatchObject({ outcome: 'accepted' });
  }
  expect(complete && resumedTransfer).toBe(true); expect(chunks.join('')).toBe(prompt.trim()); expect(model).not.toHaveBeenCalled();
  expect(JSON.stringify(f.store.snapshot().interactions)).not.toContain('large retained user prompt');
});
