import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { bindFelanExtension, SessionManager, type AgentRuntime } from '@felan-ai/agent-core';
import { MEMORY_VIEW_PRESENTER, decodeMemoryDocument, parseMemoryViewChunk, parseMemoryViewRequest, type MemoryViewChoice } from '@felan-ai/ext-memory/view';
import { createMemoryControlExtension } from '../../daemon/src/memory/control.js';
import type { LocalMemoryCoordinator } from '../../daemon/src/memory/coordinator.js';
import { createRegistryInteractionBroker } from '../../daemon/src/daemon/broker.js';
import { createSessionExtensionUi, SESSION_UI_PRESENTERS } from '../../daemon/src/daemon/extension-ui.js';
import { DaemonConfiguration } from '../../daemon/src/daemon/configuration.js';
import { SessionServer } from '../../daemon/src/daemon/server.js';
import { serverFixture } from '../../daemon/test/fixtures/server.js';
import { SessionClient } from '../src/client/client.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

it('serves a bound memory command, preserves reconnect state and inspects a retained run without dispatching memory work', async () => {
  let broker!: ReturnType<typeof createRegistryInteractionBroker>; let bridge!: ReturnType<typeof createSessionExtensionUi>;
  let runtime!: AgentRuntime; let agentDir = ''; let sessionDir = ''; let cwd = '';
  const runNow = vi.fn();
  const coordinator = { status: async () => ({ enabled: true, state: 'idle', pendingCheckpoints: 0 }),
    subscribeStatusChanges: () => () => {}, setSelectedModel() {}, runNow } as unknown as LocalMemoryCoordinator;
  const f = await serverFixture({ now: () => Date.now(), extensionUi(context, registry) {
    runtime = context.runtime; agentDir = context.resources.agentDir; cwd = context.resources.cwd;
    sessionDir = context.sessionManager.getSessionDir();
    broker ??= createRegistryInteractionBroker(registry, { presenters: SESSION_UI_PRESENTERS });
    bridge = createSessionExtensionUi({ broker, scope: { kind: 'session', session: context.sessionManager.getSessionId(), root: context.rootSessionId } }); return bridge;
  }, extension(pi) {
    const bound = bindFelanExtension('fixture-memory', createMemoryControlExtension({ coordinator, agentDir, presentation: bridge.memory }), runtime, agentDir);
    return typeof bound === 'function' ? bound(pi) : bound.factory(pi);
  } });
  const clients: SessionClient[] = []; let server: SessionServer | undefined;
  cleanups.push(async () => { for (const client of clients) client.close(); server?.close(); bridge.dispose(); await broker.drain(); await f.dispose(); });
  const retained = SessionManager.create(cwd, join(sessionDir, 'memory'));
  retained.appendMessage({ role: 'user', content: 'retained fixture marker', timestamp: Date.now() });
  retained.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'retained response '.repeat(8000) }],
    api: 'openai-responses', provider: 'fixture', model: 'fixture', stopReason: 'stop', timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const configuration = new DaemonConfiguration({ agentDir, definitions: [], assertCurrent: () => f.registry.assertAdmission() });
  server = new SessionServer({ registry: f.registry, configuration, models: f.root.runtime.session.modelRuntime, version: 'fixture', broker });
  bridge.activate(update => f.registry.projection(f.root.sessionId).setPresentation(update)); await server.start();
  const connect = async () => {
    const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
      expected: f.owner.identity, clientVersion: 'fixture', kind: 'tui', presenters: [MEMORY_VIEW_PRESENTER], interactionKinds: ['custom'], requestTimeoutMs: 1000, retries: 0 });
    clients.push(client); await client.connect(); await client.attach(f.root.sessionId); return client;
  };
  const pending = () => f.store.snapshot().interactions.find(item => item.state === 'waiting' && item.request.kind === 'custom' && item.request.presenter.id === MEMORY_VIEW_PRESENTER.id);
  let client = await connect();
  expect(await client.request('command.invoke', { name: 'memory', arguments: '' }, { session: f.root.sessionId })).toMatchObject({ outcome: 'accepted' });
  await vi.waitFor(() => expect(pending()).toBeDefined()); const original = pending()!;
  client.close(); client = await connect();
  await vi.waitFor(() => expect(client.getAttachment(f.root.sessionId)?.state.snapshot?.interactions).toContainEqual(expect.objectContaining({ id: original.id })));
  let lastId = ''; let parts: string[] = []; let inspected = false; let complete = false;
  for (let step = 0; step < 100 && !complete; step++) {
    await vi.waitFor(() => { expect(pending()).toBeDefined(); expect(pending()!.id).not.toBe(lastId); });
    const item = pending(); expect(item).toBeDefined(); lastId = item!.id;
    if (item!.request.kind !== 'custom') throw new Error(); const request = parseMemoryViewRequest(item!.request.data);
    let chunk: ReturnType<typeof parseMemoryViewChunk> | undefined;
    await vi.waitFor(() => {
      const page = client.getAttachment(f.root.sessionId)?.state.snapshot?.presentation.find(value => value.id === `memory:${request.viewId}`);
      if (page?.kind === 'custom') chunk = parseMemoryViewChunk(page.data);
      expect(chunk).toMatchObject({ documentId: request.documentId, index: request.index });
    });
    if (request.index === 0) parts = []; parts.push(chunk!.text);
    let action: MemoryViewChoice;
    if (request.index < request.chunks - 1) action = { action: 'chunk', index: request.index + 1 };
    else {
      const document = decodeMemoryDocument(parts.join(''), request.kind);
      if (document.kind === 'catalog') { expect(document.sessions[0]?.id).toBe(retained.getSessionId()); action = { action: 'inspect', key: document.sessions[0]!.key }; }
      else { expect(JSON.stringify(document.messages)).toContain('retained response'); inspected = true; complete = true; action = { action: 'close' }; }
    }
    expect(await client.request('interaction.answer', { interactionId: item!.id,
      answer: { kind: 'custom', presenter: MEMORY_VIEW_PRESENTER, data: { ...action, viewId: request.viewId, sequence: request.sequence } } }, { session: f.root.sessionId })).toMatchObject({ outcome: 'accepted' });
  }
  expect(complete && inspected).toBe(true); expect(runNow).not.toHaveBeenCalled();
  expect(JSON.stringify(f.store.snapshot().interactions)).not.toContain('retained fixture marker');
});
