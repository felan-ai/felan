import { afterEach, expect, it, vi } from 'vitest';
import { bindFelanExtension, type AgentRuntime } from '@felan-ai/agent-core';
import { createContextViewExtension } from '@felan-ai/ext-context-view';
import { CONTEXT_VIEW_PRESENTER, parseContextViewRequest } from '@felan-ai/ext-context-view/view';
import { SessionClient } from '../src/client/client.js';
import { createRegistryInteractionBroker } from '../../daemon/src/daemon/broker.js';
import { createSessionExtensionUi, SESSION_UI_PRESENTERS } from '../../daemon/src/daemon/extension-ui.js';
import { DaemonConfiguration } from '../../daemon/src/daemon/configuration.js';
import { SessionServer } from '../../daemon/src/daemon/server.js';
import { serverFixture } from '../../daemon/test/fixtures/server.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

it('runs the bound context command and restores the same report after reconnect', async () => {
  let broker!: ReturnType<typeof createRegistryInteractionBroker>; let bridge!: ReturnType<typeof createSessionExtensionUi>;
  let runtime!: AgentRuntime; let agentDir = '';
  const f = await serverFixture({ now: () => Date.now(), extensionUi(context, registry) {
    runtime = context.runtime; agentDir = context.resources.agentDir;
    broker ??= createRegistryInteractionBroker(registry, { presenters: SESSION_UI_PRESENTERS });
    bridge = createSessionExtensionUi({ broker, scope: { kind: 'session', session: context.sessionManager.getSessionId(), root: context.rootSessionId } }); return bridge;
  }, extension(pi) {
    const bound = bindFelanExtension('fixture-context', createContextViewExtension(bridge.contextView), runtime, agentDir);
    return typeof bound === 'function' ? bound(pi) : bound.factory(pi);
  } });
  const clients: SessionClient[] = []; let server: SessionServer | undefined;
  cleanups.push(async () => { for (const client of clients) client.close(); server?.close(); bridge.dispose(); await broker.drain(); await f.dispose(); });
  const configuration = new DaemonConfiguration({ agentDir: f.owner.target.agentDir, definitions: [], assertCurrent: () => f.registry.assertAdmission() });
  server = new SessionServer({ registry: f.registry, configuration, models: f.root.runtime.session.modelRuntime, version: 'fixture', broker });
  bridge.activate(update => f.registry.projection(f.root.sessionId).setPresentation(update)); await server.start();
  const connect = async () => {
    const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
      expected: f.owner.identity, clientVersion: 'fixture', kind: 'tui', presenters: [CONTEXT_VIEW_PRESENTER], interactionKinds: ['custom'], requestTimeoutMs: 1000, retries: 0 });
    clients.push(client); await client.connect(); await client.attach(f.root.sessionId); return client;
  };
  const pending = () => f.store.snapshot().interactions.find(item => item.state === 'waiting' && item.request.kind === 'custom' && item.request.presenter.id === CONTEXT_VIEW_PRESENTER.id);
  const first = await connect();
  expect(await first.request('command.invoke', { name: 'context', arguments: '' }, { session: f.root.sessionId })).toMatchObject({ outcome: 'accepted' });
  await vi.waitFor(() => expect(pending()).toBeDefined()); const item = pending()!;
  if (item.request.kind !== 'custom') throw new Error(); const request = parseContextViewRequest(item.request.data);
  expect(request.report.estimated).toBe(true); expect(request.report).not.toHaveProperty('systemPrompt');
  first.close(); const second = await connect(); await vi.waitFor(() => expect(pending()).toBeDefined());
  expect(pending()!.request).toEqual(item.request);
  await vi.waitFor(() => expect(second.getAttachment(f.root.sessionId)?.state.snapshot?.interactions.find(interaction => interaction.id === item.id))
    .toMatchObject({ state: 'waiting', request: item.request }));
  expect(await second.request('interaction.answer', { interactionId: item.id, answer: { kind: 'custom', presenter: CONTEXT_VIEW_PRESENTER, data: { closed: false } } }, { session: f.root.sessionId })).toMatchObject({ outcome: 'rejected' });
  expect(pending()).toBeDefined();
  expect(await second.request('interaction.answer', { interactionId: item.id, answer: { kind: 'custom', presenter: CONTEXT_VIEW_PRESENTER, data: { closed: true } } }, { session: f.root.sessionId })).toMatchObject({ outcome: 'accepted' });
  await vi.waitFor(() => expect(pending()).toBeUndefined());
});
