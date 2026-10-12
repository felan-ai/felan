import { afterEach, expect, it, vi } from 'vitest';
import { bindFelanExtension, type AgentRuntime } from '@felan-ai/agent-core';
import { BackgroundBashManager, createBackgroundBashExtension, type BackgroundBashJob } from '@felan-ai/ext-background-bash';
import { PROCESS_VIEW_PRESENTER, parseProcessViewRequest, processViewAction, type ProcessViewRequest } from '@felan-ai/ext-background-bash/view';
import type { JsonValue } from '@felan-ai/session-protocol';
import { SessionClient } from '../src/client/client.js';
import { createRegistryInteractionBroker } from '../../daemon/src/daemon/broker.js';
import { createSessionExtensionUi, SESSION_UI_PRESENTERS } from '../../daemon/src/daemon/extension-ui.js';
import { DaemonConfiguration } from '../../daemon/src/daemon/configuration.js';
import { SessionServer } from '../../daemon/src/daemon/server.js';
import { serverFixture } from '../../daemon/test/fixtures/server.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { try { for (const close of cleanups.splice(0).reverse()) await close(); } finally { vi.restoreAllMocks(); } });

it('runs the real process command, restores its page and does not replay a signal on reconnect', async () => {
  let jobs = Array.from({ length: 23 }, (_, index) => ({ meta: { id: `job-${index}`, command: 'echo test', startedAt: 1 }, status: { status: 'running', updatedAt: 1 } }) as BackgroundBashJob);
  vi.spyOn(BackgroundBashManager.prototype, 'list').mockImplementation(async () => jobs);
  vi.spyOn(BackgroundBashManager.prototype, 'tail').mockResolvedValue('bounded process output');
  const stop = vi.spyOn(BackgroundBashManager.prototype, 'stop').mockImplementation(async id => {
    jobs = jobs.map(job => job.meta.id === id ? { ...job, status: { ...job.status, status: 'killed' } } : job); return jobs.find(job => job.meta.id === id)!;
  });
  let broker!: ReturnType<typeof createRegistryInteractionBroker>; let bridge!: ReturnType<typeof createSessionExtensionUi>;
  let runtime!: AgentRuntime; let agentDir = '';
  const f = await serverFixture({ now: () => Date.now(), extensionUi(context, registry) {
    runtime = context.runtime; agentDir = context.resources.agentDir;
    broker ??= createRegistryInteractionBroker(registry, { presenters: SESSION_UI_PRESENTERS });
    bridge = createSessionExtensionUi({ broker, scope: { kind: 'session', session: context.sessionManager.getSessionId(), root: context.rootSessionId } }); return bridge;
  }, extension(pi) {
    const bound = bindFelanExtension('fixture-processes', createBackgroundBashExtension(undefined, true, bridge.backgroundBash), runtime, agentDir);
    return typeof bound === 'function' ? bound(pi) : bound.factory(pi);
  } });
  const clients: SessionClient[] = []; let server: SessionServer | undefined;
  cleanups.push(async () => { for (const client of clients) client.close(); server?.close(); bridge.dispose(); await broker.drain(); await f.dispose(); });
  const configuration = new DaemonConfiguration({ agentDir: f.owner.target.agentDir, definitions: [], assertCurrent: () => f.registry.assertAdmission() });
  server = new SessionServer({ registry: f.registry, configuration, models: f.root.runtime.session.modelRuntime, version: 'fixture', broker });
  bridge.activate(update => f.registry.projection(f.root.sessionId).setPresentation(update)); await server.start();
  const connect = async () => {
    const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
      expected: f.owner.identity, clientVersion: 'fixture', kind: 'tui', presenters: [PROCESS_VIEW_PRESENTER], interactionKinds: ['custom'], requestTimeoutMs: 1000, retries: 0 });
    clients.push(client); await client.connect(); await client.attach(f.root.sessionId); return client;
  };
  const pending = () => f.store.snapshot().interactions.find(item => item.state === 'waiting' && item.request.kind === 'custom' && item.request.presenter.id === PROCESS_VIEW_PRESENTER.id);
  const next = async (previous?: string) => {
    await vi.waitFor(() => expect(pending() && pending()!.id !== previous).toBe(true)); const item = pending()!;
    if (item.request.kind !== 'custom') throw new Error(); return { item, state: parseProcessViewRequest(item.request.data) };
  };
  const answer = (client: SessionClient, item: Awaited<ReturnType<typeof next>>, action: Parameters<typeof processViewAction>[1]) => client.request('interaction.answer', {
    interactionId: item.item.id, answer: { kind: 'custom', presenter: PROCESS_VIEW_PRESENTER, data: processViewAction(item.state, action) as unknown as JsonValue },
  }, { session: f.root.sessionId });
  const first = await connect();
  expect(await first.request('command.invoke', { name: 'processes', arguments: '' }, { session: f.root.sessionId })).toMatchObject({ outcome: 'accepted' });
  let current = await next(); expect(current.state.jobs).toHaveLength(18);
  await answer(first, current, { action: 'page', offset: 18, select: 'last' }); current = await next(current.item.id);
  expect(current.state.jobs).toHaveLength(5); expect(current.state.selectedId).toBe('job-22');
  await answer(first, current, { action: 'detail', id: 'job-22' }); current = await next(current.item.id);
  expect(current.state.detail?.text).toBe('bounded process output');
  const before: ProcessViewRequest = current.state; first.close(); const second = await connect();
  await vi.waitFor(() => expect(pending()).toBeDefined());
  expect(parseProcessViewRequest((pending()!.request as { data: JsonValue }).data)).toEqual(before); expect(stop).not.toHaveBeenCalled();
  const signalItem = current;
  expect(await answer(second, signalItem, { action: 'signal', id: 'job-22', signal: 'SIGTERM' })).toMatchObject({ outcome: 'accepted' });
  current = await next(signalItem.item.id); expect(current.state.notice).toContain('Stop requested');
  await answer(second, signalItem, { action: 'signal', id: 'job-22', signal: 'SIGTERM' });
  expect(stop).toHaveBeenCalledExactlyOnceWith('job-22', 'SIGTERM');
  await answer(second, current, { action: 'close' }); await vi.waitFor(() => expect(pending()).toBeUndefined());
});
