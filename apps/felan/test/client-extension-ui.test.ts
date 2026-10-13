import { sessionUiPort } from './session-ui-fixture.js';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionClient } from '../src/client/client.js';
import { createRegistryInteractionBroker } from '../../daemon/src/daemon/broker.js';
import { createSessionExtensionUi } from '../../daemon/src/daemon/extension-ui.js';
import { DaemonConfiguration } from '../src/providers/configuration.js';
import { SessionServer } from '../../daemon/src/daemon/server.js';
import { serverFixture } from '../../daemon/test/fixtures/server.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('shares an extension dialog and buffered presentation across client detach', async () => {
  const f = await serverFixture({ now: () => Date.now() });
  const broker = createRegistryInteractionBroker(f.registry);
  const bridge = createSessionExtensionUi({ port: sessionUiPort(broker, { kind: 'session', session: f.root.sessionId, root: f.root.rootSessionId }) });
  const configuration = new DaemonConfiguration({ agentDir: f.owner.target.agentDir, definitions: [], assertCurrent: () => f.registry.assertAdmission() });
  const server = new SessionServer({ registry: f.registry, configuration, models: f.root.runtime.session.modelRuntime, version: 'fixture', broker });
  const clients: SessionClient[] = [];
  cleanups.push(async () => { for (const client of clients) client.close(); server.close(); bridge.dispose(); await broker.drain(); await f.dispose(); });
  bridge.context.setWidget('starting', ['Ready'], { placement: 'belowEditor' });
  bridge.activate(update => f.registry.projection(f.root.sessionId).setPresentation(update));
  await server.start();
  const connect = async () => {
    const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
      expected: f.owner.identity, clientVersion: 'fixture', kind: 'tui', interactionKinds: ['select'], requestTimeoutMs: 1000, retries: 0 });
    clients.push(client); await client.connect(); expect((await client.attach(f.root.sessionId)).outcome).toBe('accepted'); return client;
  };
  const first = await connect();
  const answer = bridge.context.select('Choose', ['One', 'Two']);
  const interaction = f.store.snapshot().interactions.at(-1)!;
  first.close();
  const next = await connect();
  expect(next.getAttachment(f.root.sessionId)?.state.snapshot?.presentation).toContainEqual(expect.objectContaining({ kind: 'widget', placement: 'belowEditor', text: 'Ready' }));
  expect(next.getAttachment(f.root.sessionId)?.state.snapshot?.interactions).toContainEqual(expect.objectContaining({ id: interaction.id, state: 'waiting' }));
  expect(await next.request('interaction.answer', { interactionId: interaction.id, answer: { kind: 'select', choices: ['1'] } }, { session: f.root.sessionId })).toMatchObject({ outcome: 'accepted' });
  await expect(answer).resolves.toBe('Two');
});

it('executes a registered command in the daemon and answers its bound UI through the client', async () => {
  let broker!: ReturnType<typeof createRegistryInteractionBroker>;
  let bridge!: ReturnType<typeof createSessionExtensionUi>;
  let chosen: string | undefined;
  const f = await serverFixture({ now: () => Date.now(),
    extensionUi(context, registry) {
      broker ??= createRegistryInteractionBroker(registry);
      bridge = createSessionExtensionUi({ port: sessionUiPort(broker, { kind: 'session', session: context.sessionManager.getSessionId(), root: context.rootSessionId }) });
      return bridge;
    },
    extension(pi) {
      pi.on('session_start', (_event, ctx) => { ctx.ui.setStatus('ready', 'Registered'); });
      pi.registerCommand('choose', { description: 'Choose a value', handler: async (_args, ctx) => {
        chosen = await ctx.ui.select('Choose', ['One', 'Two']);
        ctx.ui.setStatus('chosen', chosen);
      } });
    },
  });
  const configuration = new DaemonConfiguration({ agentDir: f.owner.target.agentDir, definitions: [], assertCurrent: () => f.registry.assertAdmission() });
  const server = new SessionServer({ registry: f.registry, configuration, models: f.root.runtime.session.modelRuntime, version: 'fixture', broker });
  const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
    expected: f.owner.identity, clientVersion: 'fixture', kind: 'tui', interactionKinds: ['select'], requestTimeoutMs: 1000, retries: 0 });
  cleanups.push(async () => { client.close(); server.close(); bridge.dispose(); await broker.drain(); await f.dispose(); });
  bridge.activate(update => f.registry.projection(f.root.sessionId).setPresentation(update));
  await server.start(); await client.connect(); await client.attach(f.root.sessionId);
  expect(client.getAttachment(f.root.sessionId)?.state.snapshot?.catalog.commands).toContainEqual(expect.objectContaining({ name: 'choose' }));
  expect(client.getAttachment(f.root.sessionId)?.state.snapshot?.presentation).toContainEqual(expect.objectContaining({ kind: 'status', value: { kind: 'text', text: 'Registered' } }));
  expect(await client.request('command.invoke', { name: 'choose', arguments: '' }, { session: f.root.sessionId }))
    .toMatchObject({ outcome: 'accepted', result: { status: 'started' } });
  const interaction = f.store.snapshot().interactions.at(-1)!;
  expect(await client.request('interaction.answer', { interactionId: interaction.id, answer: { kind: 'select', choices: ['1'] } }, { session: f.root.sessionId }))
    .toMatchObject({ outcome: 'accepted' });
  await vi.waitFor(() => expect(chosen).toBe('Two'));
});
