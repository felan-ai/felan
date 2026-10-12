import { afterEach, expect, it, vi } from 'vitest';
import { bindFelanExtension, type AgentRuntime } from '@felan-ai/agent-core';
import { createTasksExtension, TaskStore } from '@felan-ai/ext-tasks';
import { TASKS_PRESENTER, parseTaskViewRequest } from '@felan-ai/ext-tasks/view';
import { SessionClient } from '../src/client/client.js';
import { createClientTaskSource } from '../src/client/tasks-presenter.js';
import { createRegistryInteractionBroker } from '../../daemon/src/daemon/broker.js';
import { createSessionExtensionUi, SESSION_UI_PRESENTERS } from '../../daemon/src/daemon/extension-ui.js';
import { DaemonConfiguration } from '../../daemon/src/daemon/configuration.js';
import { SessionServer } from '../../daemon/src/daemon/server.js';
import { serverFixture } from '../../daemon/test/fixtures/server.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

it('executes the real tasks command, streams updates and details, and restores the pending view on reconnect', async () => {
  let broker!: ReturnType<typeof createRegistryInteractionBroker>; let bridge!: ReturnType<typeof createSessionExtensionUi>;
  let runtime!: AgentRuntime; let agentDir = '';
  const f = await serverFixture({ now: () => Date.now(),
    extensionUi(context, registry) {
      runtime = context.runtime; agentDir = context.resources.agentDir;
      broker ??= createRegistryInteractionBroker(registry, { presenters: SESSION_UI_PRESENTERS });
      bridge = createSessionExtensionUi({ broker, scope: { kind: 'session', session: context.sessionManager.getSessionId(), root: context.rootSessionId } });
      return bridge;
    },
    extension(pi) {
      const bound = bindFelanExtension('fixture-tasks', createTasksExtension(bridge.tasks), runtime, agentDir);
      return typeof bound === 'function' ? bound(pi) : bound.factory(pi);
    },
  });
  const clients: SessionClient[] = []; const sources: Array<{ dispose(): void }> = [];
  let store: TaskStore | undefined; let server: SessionServer | undefined;
  cleanups.push(async () => { for (const source of sources) source.dispose(); for (const client of clients) client.close(); server?.close(); bridge.dispose(); await broker.drain(); store?.close(); await f.dispose(); });
  store = new TaskStore(runtime); const first = await store.create({ title: 'First' });
  await store.update({ taskId: first.task.id, notes: 'Full task details' }, 'fixture');
  const configuration = new DaemonConfiguration({ agentDir: f.owner.target.agentDir, definitions: [], assertCurrent: () => f.registry.assertAdmission() });
  server = new SessionServer({ registry: f.registry, configuration, models: f.root.runtime.session.modelRuntime, version: 'fixture', broker });
  bridge.activate(update => f.registry.projection(f.root.sessionId).setPresentation(update)); await server.start();
  const connect = async () => {
    const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
      expected: f.owner.identity, clientVersion: 'fixture', kind: 'tui', presenters: [TASKS_PRESENTER], interactionKinds: ['custom'], requestTimeoutMs: 1000, retries: 0 });
    clients.push(client); await client.connect(); await client.attach(f.root.sessionId); return client;
  };
  const firstClient = await connect();
  expect(await firstClient.request('command.invoke', { name: 'tasks', arguments: '' }, { session: f.root.sessionId })).toMatchObject({ outcome: 'accepted' });
  const pending = () => f.store.snapshot().interactions.find(item => item.state === 'waiting' && item.request.kind === 'custom' && item.request.presenter.id === TASKS_PRESENTER.id);
  await vi.waitFor(() => expect(pending()).toBeDefined()); const initial = pending()!;
  if (initial.request.kind !== 'custom') throw new Error('Expected task interaction');
  const view = parseTaskViewRequest(initial.request.data);
  const control = new AbortController();
  let failure: unknown;
  const read = (client: SessionClient) => createClientTaskSource({ read: () => client.getAttachment(f.root.sessionId)?.state.snapshot?.presentation ?? [], subscribe: callback => client.subscribe(callback) },
    view.viewId, control.signal, error => { failure = error; control.abort(error); });
  const source = read(firstClient); sources.push(source);
  expect((await source.source.snapshot()).tasks).toHaveLength(1);
  await store.create({ title: 'Second' });
  await vi.waitFor(async () => expect((await source.source.snapshot()).tasks).toHaveLength(2));
  expect(await firstClient.request('interaction.answer', { interactionId: initial.id, answer: { kind: 'custom', presenter: TASKS_PRESENTER, data: { action: 'detail', taskId: first.task.id } } }, { session: f.root.sessionId })).toMatchObject({ outcome: 'accepted' });
  await vi.waitFor(async () => expect((await source.source.snapshot()).tasks.find(task => task.id === first.task.id)?.notes).toBe('Full task details'));
  firstClient.close(); source.dispose();
  const secondClient = await connect(); const restored = read(secondClient); sources.push(restored);
  expect((await restored.source.snapshot()).tasks.find(task => task.id === first.task.id)?.notes).toBe('Full task details');
  await vi.waitFor(() => expect(pending()?.id).not.toBe(initial.id)); const final = pending()!;
  expect(await secondClient.request('interaction.answer', { interactionId: final.id, answer: { kind: 'custom', presenter: TASKS_PRESENTER, data: { action: 'close' } } }, { session: f.root.sessionId })).toMatchObject({ outcome: 'accepted' });
  await vi.waitFor(() => expect(secondClient.getAttachment(f.root.sessionId)?.state.snapshot?.presentation.some(item => item.id.startsWith(`tasks:${view.viewId}:`))).toBe(false));
  expect(failure).toBeUndefined();
});
