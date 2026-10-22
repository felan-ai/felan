import { sessionUiPort } from './session-ui-fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionContext } from '@felan-ai/agent-core';
import { LIMITS, parseInteraction, type Interaction } from '@felan-ai/session-protocol';
import { SessionClient, newRequestId } from '../src/client/client.js';
import { createBrowserAuthorizationPresentation } from '../src/providers/ui/extension-ui.js';
import { createSessionExtensionUi } from '../../daemon/src/daemon/extension-ui.js';
import { createLocalBrowserAuthorizationHost } from '../src/providers/browser/authorization-host.js';
import type { AgentRuntime } from '@felan-ai/agent-core';
import { InteractionBroker, createRegistryInteractionBroker } from '../../daemon/src/daemon/broker.js';
import { DaemonConfiguration } from '../src/providers/configuration.js';
import { DaemonControlStore } from '../../daemon/src/daemon/control-store.js';
import { SessionServer } from '../../daemon/src/daemon/server.js';
import { createUiVocabulary } from '../../daemon/src/daemon/ui-vocabulary.js';
import { serverFixture } from '../../daemon/test/fixtures/server.js';
import { createUiAskUserHost } from '../../../packages/ext-ask-user/src/ui.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(extension?: (pi: ExtensionAPI) => void) {
  const f = await serverFixture({ now: () => Date.now(), ...(extension ? { extension } : {}) });
  const published: Interaction[] = [];
  const resumed = vi.fn(async (_session: string, _answer: unknown, _id: string, dispatch: () => void) => { dispatch(); });
  const broker = new InteractionBroker({ store: f.store, now: () => Date.now(), resume: resumed,
    publish: (interaction, revisions) => { published.push(interaction); f.registry.publishInteraction(interaction, revisions); } });
  const configuration = new DaemonConfiguration({ agentDir: f.owner.target.agentDir, definitions: [], assertCurrent: () => f.registry.assertAdmission() });
  const server = new SessionServer({ registry: f.registry, configuration, models: f.root.runtime.session.modelRuntime, version: 'fixture', broker });
  const clients: SessionClient[] = [];
  await server.start();
  cleanups.push(async () => {
    for (const client of clients) client.close();
    server.close();
    await broker.drain();
    await f.dispose();
  });
  const scope = { kind: 'session', session: f.root.sessionId, root: f.root.sessionId } as const;
  async function client(kind: 'tui' | 'acp' | 'headless' = 'tui', attach = true, forms = true, options: { retries?: number; actions?: boolean } = {}) {
    const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
      expected: f.owner.identity, clientVersion: 'fixture', kind, interactionKinds: kind === 'headless' ? [] : ['select', 'confirm', 'input', 'tool_approval', 'dependency',
        ...(forms ? ['form' as const] : [])],
      capabilities: options.actions ? ['ui.action'] : [],
      requestTimeoutMs: 1000, retries: options.retries ?? 0 });
    clients.push(client);
    await client.connect();
    if (attach) expect((await client.attach(f.root.sessionId)).outcome).toBe('accepted');
    return client;
  }
  return { ...f, broker, published, resumed, server, scope, client };
}

function setClientAuthority(f: Awaited<ReturnType<typeof fixture>>, client: SessionClient, kind: 'tui' | 'acp',
  authority: { principal?: string }) {
  const capabilities = client.capabilities!;
  f.broker.connected({ principal: authority.principal ?? f.server.principal, kind, attachment: capabilities.attachmentId,
    sessions: [f.root.sessionId], interactionKinds: capabilities.interactionKinds });
}

function askUserHost(f: Awaited<ReturnType<typeof fixture>>) {
  const vocabulary = createUiVocabulary({ canRequest: () => true, publish() {}, async request(form, options) {
    const result = await f.broker.request({ kind: 'form', form }, f.scope, {
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.deferrable === undefined ? {} : { deferrable: options.deferrable }),
      ...(options?.timeoutMs === undefined ? {} : { timeout: Math.ceil(options.timeoutMs) }),
    });
    if (result.state !== 'answered') return result;
    if (result.answer.kind !== 'form') throw new Error('Expected a generic form answer.');
    return { state: 'answered', answer: result.answer };
  } });
  cleanups.push(() => vocabulary.dispose());
  return createUiAskUserHost(vocabulary.createExtensionUi('@felan-ai/ext-ask-user'));
}

describe('InteractionBroker', () => {
  it.each([true, false])('returns explicit Pi confirm=%s through pruning and an unpersisted answer retry', async confirmed => {
    const f = await fixture(); const session = f.root.sessionId;
    for (let index = 0; index < 1001; index++) f.store.putResource({ id: `finished-${index}`, session, root: session,
      kind: 'detached', state: 'exited', updatedAt: 0 });
    const client = await f.client('tui', true, true, { retries: 2 }); const attachment = client.capabilities!.attachmentId;
    const bridge = createSessionExtensionUi({ port: sessionUiPort(f.broker, f.scope) }); bridge.activate(() => {});
    cleanups.push(async () => bridge.dispose());
    let settled = false;
    const waiting = bridge.context.confirm('Git Push', 'Synthetic confirmation; no command is executed.').then(value => { settled = true; return value; });
    await vi.waitFor(() => expect(client.getInteractions({ includeSessions: true })).toHaveLength(1));
    expect(settled).toBe(false);
    const interaction = client.getInteractions({ includeSessions: true })[0]!;
    const admit = vi.spyOn(f.store, 'admit'); const dispatch = vi.spyOn(f.broker, 'dispatch');
    expect(await client.request('interaction.answer', { interactionId: interaction.id, answer: { kind: 'confirm', confirmed } }, { session }))
      .toMatchObject({ outcome: 'accepted' });
    await expect(waiting).resolves.toBe(confirmed);
    await vi.waitFor(() => {
      expect(client.capabilities!.attachmentId).not.toBe(attachment);
      expect(client.getAttachment(session)?.state.status).toBe('live');
    });
    const attempts = admit.mock.calls.filter(([value]) => (value as { op?: string }).op === 'interaction.answer');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]![0]).toEqual(attempts[1]![0]);
    expect(dispatch).toHaveBeenCalledOnce(); expect(f.store.resources(session)).toHaveLength(1000);
    expect(client.getInteractions({ includeSessions: true })).toEqual([]);
  });

  it.each([true, false])('completes a retried UI action with nested Pi confirm=%s after pruning', async confirmed => {
    const f = await fixture(); const session = f.root.sessionId;
    const client = await f.client('tui', true, true, { retries: 2, actions: true });
    const attachment = client.capabilities!.attachmentId;
    const bridge = createSessionExtensionUi({ port: sessionUiPort(f.broker, f.scope) }); bridge.activate(() => {});
    cleanups.push(async () => bridge.dispose());
    const handler = vi.fn(async () => {
      expect(await bridge.context.confirm('Nested action', 'Synthetic confirmation; no command is executed.')).toBe(confirmed);
    });
    const unregister = f.registry.registerUiActions(session, () => handler);
    cleanups.push(async () => unregister());
    for (let index = 0; index < 1001; index++) f.store.putResource({ id: `finished-${index}`, session, root: session,
      kind: 'detached', state: 'exited', updatedAt: 0 });
    const response = client.request('ui.action', { elementId: 'nested', revision: 1, actionId: 'submit', outcome: 'submit', values: {} }, { session });
    await vi.waitFor(() => expect(client.getInteractions({ includeSessions: true })).toHaveLength(1));
    expect(client.capabilities!.attachmentId).not.toBe(attachment);
    const interaction = client.getInteractions({ includeSessions: true })[0]!;
    expect(await client.request('interaction.answer', { interactionId: interaction.id, answer: { kind: 'confirm', confirmed } }, { session }))
      .toMatchObject({ outcome: 'accepted' });
    expect(await response).toMatchObject({ outcome: 'accepted' });
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each(['host', 'session'] as const)('answers %s interactions from equally capable clients', async kind => {
    const f = await fixture();
    const scope = kind === 'host' ? { kind: 'host' as const } : f.scope;
    const interaction = parseInteraction({ id: `capable-${kind}`, state: 'waiting', scope, createdAt: Date.now(),
      request: { kind: 'confirm', title: 'Shared prompt', message: 'Continue?' } });
    f.store.putInteraction(interaction);
    const client = await f.client('acp');
    await vi.waitFor(() => expect(client.getInteractions({ includeSessions: true })).toContainEqual(expect.objectContaining({ id: interaction.id })));
    expect((await client.request('interaction.answer', { interactionId: interaction.id, answer: { kind: 'confirm', confirmed: true } },
      kind === 'session' ? { session: f.root.sessionId } : undefined)).outcome).toBe('accepted');
    expect(f.store.snapshot().interactions.find(item => item.id === interaction.id)).toMatchObject({ state: 'answered' });
  });

  it('requires the owner principal for session approvals', async () => {
    const f = await fixture(); const client = await f.client('acp');
    setClientAuthority(f, client, 'acp', { principal: 'remote:other-user' });
    const request = { kind: 'confirm', title: 'Owner approval', message: 'Approve this session action?' } as const;
    const waiting = f.broker.request(request, f.scope, { authority: 'owner' });
    const item = f.broker.pending()[0]!;
    expect(item).toMatchObject({ scope: f.scope, authority: 'owner' });
    expect(f.broker.canReceive(client.capabilities!.attachmentId, item)).toBe(false);
    expect(() => f.broker.presentationRequest(item.id, client.capabilities!.attachmentId)).toThrow();
    expect((await client.request('interaction.answer', { interactionId: item.id,
      answer: { kind: 'confirm', confirmed: true } }, { session: f.root.sessionId })).outcome).toBe('rejected');
    setClientAuthority(f, client, 'acp', {});
    expect(f.broker.canReceive(client.capabilities!.attachmentId, item)).toBe(true);
    expect((await client.request('interaction.answer', { interactionId: item.id,
      answer: { kind: 'confirm', confirmed: true } }, { session: f.root.sessionId })).outcome).toBe('accepted');
    await expect(waiting).resolves.toMatchObject({ state: 'answered' });
  });

  it('keeps creator-affine host trust prompts bound to their original local connection', async () => {
    const f = await fixture(); const creator = await f.client('acp', false); const other = await f.client('tui', false);
    const request = { kind: 'confirm', title: 'Trust project?', message: f.cwd } as const;
    const scope = { kind: 'host', recipient: creator.capabilities!.attachmentId } as const;
    const waiting = f.broker.request(request, scope); const item = f.broker.pending()[0]!;
    expect(f.broker.canReceive(other.capabilities!.attachmentId, item)).toBe(false);
    expect((await other.request('interaction.answer', { interactionId: item.id,
      answer: { kind: 'confirm', confirmed: true } })).outcome).toBe('rejected');
    creator.close();
    await expect(waiting).resolves.toEqual({ state: 'cancelled', reason: 'abort' });
    expect(f.broker.pending()).toEqual([]);
  });

  it.each(['tui', 'acp'] as const)('requires owner consent through capable %s clients before native Chrome inspection', async kind => {
    const f = await fixture();
    const bridge = createSessionExtensionUi({ port: sessionUiPort(f.broker, f.scope) }); bridge.activate(() => {});
    cleanups.push(async () => bridge.dispose());
    const inspect = vi.fn(async () => ({ state: 'ready' as const, processId: 1, connection: { port: 1234, webSocketPath: '/private' } }));
    const lease = { connection: { port: 1234, webSocketPath: '/private' }, signal: new AbortController().signal, connected: true, close: vi.fn(async () => {}) };
    const attach = vi.fn(async () => ({ ready: true }));
    const host = createLocalBrowserAuthorizationHost({ runtime: { kind: 'host' } as AgentRuntime, presentation: createBrowserAuthorizationPresentation({ port: sessionUiPort(f.broker, f.scope), openBrowserSetup: async () => {} }), inspect, createLease: async () => lease });
    const context = { mode: 'print', hasUI: true, ui: bridge.context } as unknown as ExtensionContext;
    const request = { origin: 'https://example.test', reason: 'Read the report.', extensionContext: context, signal: new AbortController().signal, attach };
    await expect(host.authorize(request)).resolves.toMatchObject({ status: 'cancelled' });
    expect(inspect).not.toHaveBeenCalled();
    const incompatible = await f.client(kind, true, false);
    expect(incompatible.capabilities?.interactionKinds).not.toContain('form');
    await expect(host.authorize(request)).resolves.toMatchObject({ status: 'cancelled' });
    expect(incompatible.getInteractions()).toEqual([]); expect(inspect).not.toHaveBeenCalled();
    const client = await f.client(kind); const pending = host.authorize(request);
    expect(client.capabilities?.interactionKinds).toContain('form');
    await vi.waitFor(() => expect(client.getInteractions({ includeSessions: true })).toHaveLength(1));
    const item = client.getInteractions({ includeSessions: true })[0]!;
    expect(item.scope).toEqual(f.scope);
    expect(item).toMatchObject({ authority: 'owner', request: { kind: 'form', form: {
      description: expect.stringContaining('Read the report.'),
    } } });
    const answer = { kind: 'form', actionId: 'once', outcome: 'submit', values: {} } as const;
    expect((await incompatible.request('interaction.answer', { interactionId: item.id, answer }, { session: f.root.sessionId })).outcome).toBe('rejected');
    expect(inspect).not.toHaveBeenCalled();
    expect((await client.request('interaction.answer', { interactionId: item.id, answer }, { session: f.root.sessionId })).outcome).toBe('accepted');
    await expect(pending).resolves.toEqual({ status: 'authorized' }); expect(attach).toHaveBeenCalledOnce();
  });

  it('reports unavailable host authorization before creating a dialog', async () => {
    const f = await fixture();
    const bridge = createSessionExtensionUi({ port: sessionUiPort(f.broker, f.scope) }); bridge.activate(() => {});
    cleanups.push(async () => bridge.dispose());
    await expect(bridge.vocabulary.createExtensionUi('@felan-ai/ext-mcp').request({ title: 'Authorize MCP server', fallback: 'Authorize locally',
      description: 'https://oauth.example.test/authorize', input: { fields: [] },
      actions: [{ id: 'cancel', label: 'Cancel', target: 'element', outcome: 'cancel' }] },
    { audience: 'host', deferrable: false, transient: true })).resolves.toEqual({ state: 'cancelled', reason: 'unsupported' });
    expect(f.broker.pending()).toEqual([]);
  });

  it.each(['tui', 'acp'] as const)('keeps host authorization pending through %s without persisting its URL', async kind => {
    const f = await fixture(); const client = await f.client(kind);
    const bridge = createSessionExtensionUi({ port: sessionUiPort(f.broker, f.scope) }); bridge.activate(() => {});
    cleanups.push(async () => bridge.dispose());
    const control = new AbortController();
    const waiting = bridge.vocabulary.createExtensionUi('@felan-ai/ext-mcp').request({ title: 'Authorize MCP server', fallback: 'Authorize locally',
      description: 'https://oauth.example.test/authorize?state=private-state', input: { fields: [] },
      actions: [{ id: 'cancel', label: 'Cancel', target: 'element', outcome: 'cancel' }] },
    { audience: 'host', deferrable: false, transient: true, signal: control.signal });
    await vi.waitFor(() => expect(client.getInteractions()).toHaveLength(1));
    const item = client.getInteractions()[0]!; expect(item.scope).toEqual({ kind: 'host' });
    expect(item.request).toMatchObject({ kind: 'form', form: { description: expect.stringContaining('private-state') } });
    expect(JSON.stringify(f.store.snapshot())).not.toContain('private-state');
    control.abort(); await waiting;
    expect(f.broker.pending()).toEqual([]);
  });

  it('cancels host authorization when the last eligible local client disconnects', async () => {
    const f = await fixture(); const client = await f.client();
    const bridge = createSessionExtensionUi({ port: sessionUiPort(f.broker, f.scope) }); bridge.activate(() => {});
    cleanups.push(async () => bridge.dispose());
    const waiting = bridge.vocabulary.createExtensionUi('@felan-ai/ext-mcp').request({ title: 'Authorize MCP server', fallback: 'Authorize locally',
      description: 'https://oauth.example.test/authorize', input: { fields: [] },
      actions: [{ id: 'cancel', label: 'Cancel', target: 'element', outcome: 'cancel' }] },
    { audience: 'host', deferrable: false, transient: true });
    await vi.waitFor(() => expect(client.getInteractions()).toHaveLength(1));
    client.close();
    await waiting; expect(f.broker.pending()).toEqual([]);
    expect(JSON.stringify(f.store.snapshot())).not.toContain('https://oauth.example.test/authorize');
  });

  it('persists before publication and records only the first concurrent answer', async () => {
    const f = await fixture();
    const tui = await f.client();
    const acp = await f.client('acp');
    const waiting = f.broker.request({ kind: 'confirm', title: 'Proceed?', message: 'Shared question' }, f.scope);
    const interaction = f.published.at(-1)!;
    expect(f.store.snapshot().interactions).toContainEqual(interaction);
    const answers = await Promise.all([tui, acp].map(client => client.request('interaction.answer', {
      interactionId: interaction.id, answer: { kind: 'confirm', confirmed: true },
    }, { session: f.root.sessionId })));
    expect(answers.filter(answer => answer.outcome === 'accepted')).toHaveLength(1);
    expect(answers.filter(answer => answer.outcome === 'rejected')).toHaveLength(1);
    await expect(waiting).resolves.toEqual({ state: 'answered', answer: { kind: 'confirm', confirmed: true } });
    const winner = answers[0]!.outcome === 'accepted' ? tui : acp;
    expect(f.store.snapshot().interactions[0]).toMatchObject({ state: 'answered', responder: winner.capabilities?.attachmentId });
  });

  it('keeps questions pending across disconnect and restores them in a new attachment', async () => {
    const f = await fixture();
    const first = await f.client();
    const waiting = f.broker.request({ kind: 'input', title: 'Name?' }, f.scope);
    const id = f.published.at(-1)!.id;
    first.close();
    const next = await f.client();
    expect(next.getAttachment(f.root.sessionId)?.state.snapshot?.interactions).toContainEqual(expect.objectContaining({ id, state: 'waiting' }));
    expect((await next.request('interaction.answer', { interactionId: id, answer: { kind: 'input', text: 'answer' } }, { session: f.root.sessionId })).outcome).toBe('accepted');
    await expect(waiting).resolves.toMatchObject({ state: 'answered' });
  });

  it('rejects answers with the wrong schema without consuming the question', async () => {
    const f = await fixture();
    const client = await f.client();
    const waiting = f.broker.request({ kind: 'confirm', title: 'Proceed?', message: 'Check' }, f.scope);
    const id = f.published.at(-1)!.id;
    expect((await client.request('interaction.answer', { interactionId: id, answer: { kind: 'input', text: 'wrong kind' } }, { session: f.root.sessionId })).outcome).toBe('rejected');
    expect(f.broker.pending()[0]?.state).toBe('waiting');
    await client.request('interaction.answer', { interactionId: id, answer: { cancelled: true, reason: 'user' } }, { session: f.root.sessionId });
    await expect(waiting).resolves.toEqual({ state: 'cancelled', reason: 'user' });
  });

  it('requires a current session attachment and rejects clients without the interaction capability', async () => {
    const f = await fixture();
    const unattached = await f.client('tui', false);
    const headless = await f.client('headless');
    const waiting = f.broker.request({ kind: 'confirm', title: 'Proceed?', message: 'Check' }, f.scope);
    const id = f.published.at(-1)!.id;
    const params = { interactionId: id, answer: { kind: 'confirm', confirmed: true } } as const;
    expect((await unattached.request('interaction.answer', params, { session: f.root.sessionId })).outcome).toBe('rejected');
    expect((await headless.request('interaction.answer', params, { session: f.root.sessionId })).outcome).toBe('rejected');
    f.broker.cancel(id, 'abort');
    await expect(waiting).resolves.toEqual({ state: 'cancelled', reason: 'abort' });
  });

  it('persists timeout and abort results', async () => {
    const f = await fixture();
    vi.useFakeTimers();
    const timed = f.broker.request({ kind: 'input', title: 'Expiring' }, f.scope, { timeout: 25 });
    await vi.advanceTimersByTimeAsync(25);
    await expect(timed).resolves.toEqual({ state: 'cancelled', reason: 'timeout' });
    expect(f.store.snapshot().interactions[0]).toMatchObject({ state: 'expired' });
    const signal = new AbortController();
    const aborted = f.broker.request({ kind: 'input', title: 'Aborting' }, f.scope, { signal: signal.signal });
    signal.abort();
    await expect(aborted).resolves.toEqual({ state: 'cancelled', reason: 'abort' });
  });

  it('defers ask-user on drain and resumes a committed answer only once', async () => {
    const f = await fixture();
    const client = await f.client();
    const waiting = askUserHost(f).ask({ questions: [{ id: 'q', question: 'Name?', header: 'Name',
      options: [], allowMultiple: false, allowFreeform: true, allowComment: false }], overlayToggleKey: null, commentToggleKey: null },
    { requestId: 'tool-call', sessionId: f.root.sessionId, signal: new AbortController().signal,
      extensionContext: {} as ExtensionContext, reportProgress() {} });
    await vi.waitFor(() => expect(f.published).toHaveLength(1));
    const id = f.published.at(-1)!.id;
    const cancelled = f.broker.request(f.published.at(-1)!.request, f.scope);
    const beforeDrain = Date.now();
    await f.broker.drain();
    await expect(waiting).resolves.toEqual({ status: 'deferred', interactionId: id });
    await expect(cancelled).resolves.toEqual({ state: 'cancelled', reason: 'drain' });
    expect(f.store.snapshot().interactions[0]).toMatchObject({ state: 'deferred', expiresAt: expect.any(Number) });
    expect(f.store.snapshot().interactions[0]!.expiresAt).toBeGreaterThanOrEqual(beforeDrain + 30 * 60 * 1000);
    expect(f.store.snapshot().interactions[0]!.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * 60 * 1000);
    expect((await client.request('interaction.answer', { interactionId: id, answer: { kind: 'form',
      actionId: 'submit', outcome: 'submit', values: { 'q.text': 'Alice' } } }, { session: f.root.sessionId })).outcome).toBe('accepted');
    expect(f.resumed).not.toHaveBeenCalled();
    const recovered = new InteractionBroker({ store: f.store, publish() {}, resume: f.resumed });
    await recovered.recover();
    await recovered.recover();
    expect(f.resumed).toHaveBeenCalledTimes(1);
    expect(f.store.snapshot().continuations[0]?.phase).toBe('completed');
    await recovered.drain();
  });

  it.each(['ready', 'dispatch_intent'] as const)('recovers a persisted %s continuation conservatively', async phase => {
    const f = await fixture();
    const client = await f.client();
    const waiting = f.broker.request({ kind: 'input', title: 'Name?' }, f.scope, { deferrable: true });
    const id = f.published.at(-1)!.id;
    await f.broker.drain(); await waiting;
    await client.request('interaction.answer', { interactionId: id, answer: { kind: 'input', text: 'Alice' } }, { session: f.root.sessionId });
    const continuation = f.store.snapshot().continuations[0]!;
    if (phase === 'dispatch_intent') f.store.transitionContinuation(continuation.id, phase);
    await f.registry.shutdown(); f.store.close();
    const store = new DaemonControlStore(f.owner);
    store.recover();
    const recovered = new InteractionBroker({ store, publish() {}, resume: f.resumed });
    await recovered.recover();
    expect(f.resumed).toHaveBeenCalledTimes(phase === 'ready' ? 1 : 0);
    expect(store.snapshot().continuations[0]?.phase).toBe(phase === 'ready' ? 'completed' : 'indeterminate');
    await recovered.drain();
    store.close();
  });

  it('allows equally capable local TUI and ACP clients to answer host trust prompts', async () => {
    const f = await fixture();
    const acp = await f.client('acp', false);
    expect(f.broker.canPresent({ kind: 'confirm', title: 'Trust?', message: f.cwd }, { kind: 'host' })).toBe(true);
    const tui = await f.client('tui', false);
    const waiting = f.broker.request({ kind: 'confirm', title: 'Trust this workspace?', message: f.cwd }, { kind: 'host' });
    const id = f.published.at(-1)!.id;
    await vi.waitFor(() => expect(tui.getInteractions()).toContainEqual(expect.objectContaining({ id })));
    await vi.waitFor(() => expect(acp.getInteractions()).toContainEqual(expect.objectContaining({ id })));
    const params = { interactionId: id, answer: { kind: 'confirm', confirmed: true } } as const;
    expect((await acp.request('interaction.answer', params)).outcome).toBe('accepted');
    expect((await tui.request('interaction.answer', params)).outcome).toBe('rejected');
    await expect(waiting).resolves.toMatchObject({ state: 'answered' });
  });

  it('replays pending host prompts after reconnect', async () => {
    const f = await fixture();
    const waiting = f.broker.request({ kind: 'dependency', dependency: 'fixture', message: 'Install?' }, { kind: 'host' });
    const client = await f.client('tui', false);
    await vi.waitFor(() => expect(client.getInteractions()).toHaveLength(1));
    const interaction = client.getInteractions()[0]!;
    await client.request('interaction.answer', { interactionId: interaction.id, answer: { kind: 'dependency', approved: false } });
    await expect(waiting).resolves.toMatchObject({ state: 'answered', answer: { approved: false } });
  });

  it('resolves waiting callers when registry cancellation commits', async () => {
    const f = await fixture();
    f.store.updateSession(f.root.sessionId, { run: { state: 'running', id: 'run', origin: { kind: 'tui', attachment: 'fixture' } } });
    const waiting = f.broker.request({ kind: 'input', title: 'Waiting' }, f.scope);
    await f.registry.cancel(f.root.sessionId);
    await expect(waiting).resolves.toEqual({ state: 'cancelled', reason: 'abort' });
  });

  it('adapts ask-user options and comments without losing their identities', async () => {
    const f = await fixture(); const client = await f.client();
    const waiting = askUserHost(f).ask({ questions: [{ id: 'q', question: 'Which?', header: 'Choice',
      options: [{ title: 'First' }, { title: 'Second' }], allowMultiple: false, allowFreeform: true, allowComment: true }] },
    { requestId: 'tool-call', sessionId: f.root.sessionId, signal: new AbortController().signal, extensionContext: {} as ExtensionContext, reportProgress() {} });
    await vi.waitFor(() => expect(f.published).toHaveLength(1));
    const interaction = f.published.at(-1)!;
    expect(interaction.request).toMatchObject({ kind: 'form', form: { input: { fields: expect.arrayContaining([
      expect.objectContaining({ id: 'q.selection', options: [{ id: 'option1', label: 'First' }, { id: 'option2', label: 'Second' }] }),
    ]) } } });
    expect((await client.request('interaction.answer', { interactionId: interaction.id, answer: { kind: 'form',
      actionId: 'submit', outcome: 'submit', values: { 'q.mode': 'selection', 'q.selection': 'option2', 'q.comment': 'selected' } } },
    { session: f.root.sessionId })).outcome).toBe('accepted');
    await expect(waiting).resolves.toEqual({ status: 'answered', answers: [{ questionId: 'q', response: { kind: 'selection', selections: ['Second'], comment: 'selected' } }] });
  });

  it('adapts a freeform ask-user question with no options', async () => {
    const f = await fixture(); const client = await f.client();
    const waiting = askUserHost(f).ask({ questions: [{ id: 'q', question: 'Name?', header: 'Name',
      options: [], allowMultiple: false, allowFreeform: true, allowComment: false }], timeout: 5001, overlayToggleKey: null, commentToggleKey: null },
    { requestId: 'tool-call', sessionId: f.root.sessionId, signal: new AbortController().signal, extensionContext: {} as ExtensionContext, reportProgress() {} });
    await vi.waitFor(() => expect(f.published).toHaveLength(1));
    const interaction = f.published.at(-1)!;
    expect(interaction.expiresAt! - interaction.createdAt).toBe(5001);
    expect(interaction.request).toMatchObject({ kind: 'form', form: { input: { fields: expect.arrayContaining([
      expect.objectContaining({ id: 'q.text', kind: 'string' }),
    ]) } } });
    if (interaction.request.kind !== 'form') throw new Error('Expected a generic ask-user form.');
    expect(interaction.request.form.input.fields.some(field => field.id === 'q.selection')).toBe(false);
    expect((await client.request('interaction.answer', { interactionId: interaction.id, answer: { kind: 'form',
      actionId: 'submit', outcome: 'submit', values: { 'q.text': 'Alice' } } },
    { session: f.root.sessionId })).outcome).toBe('accepted');
    await expect(waiting).resolves.toEqual({ status: 'answered', answers: [{ questionId: 'q', response: { kind: 'freeform', text: 'Alice' } }] });
  });

  it('resumes a deferred answer through the real registry only after dispatch is durable', async () => {
    const f = await fixture(); const client = await f.client();
    const requestId = newRequestId();
    f.store.admit({ v: 1, id: requestId, op: 'prompt', session: f.root.sessionId, params: { text: 'Ask my name' } }, f.server.principal);
    const waiting = f.registry.runAdmitted(requestId, f.root.sessionId, { kind: 'tui', attachment: 'tool-client' }, () =>
      askUserHost(f).ask({ questions: [{ id: 'q', question: 'Name?', header: 'Name', options: [],
        allowMultiple: false, allowFreeform: true, allowComment: false }], overlayToggleKey: null, commentToggleKey: null },
      { requestId: 'tool-call', sessionId: f.root.sessionId, signal: new AbortController().signal,
        extensionContext: {} as ExtensionContext, reportProgress() {} }));
    await vi.waitFor(() => expect(f.published).toHaveLength(1));
    const id = f.published.at(-1)!.id;
    await f.broker.drain();
    await expect(waiting).resolves.toEqual({ status: 'deferred', interactionId: id });
    await client.request('interaction.answer', { interactionId: id, answer: { kind: 'form',
      actionId: 'submit', outcome: 'submit', values: { 'q.text': 'Alice' } } }, { session: f.root.sessionId });
    const original = f.root.runtime.session.prompt.bind(f.root.runtime.session);
    const prompt = vi.spyOn(f.root.runtime.session, 'prompt').mockImplementation(async (...args) => {
      expect(f.store.snapshot().continuations[0]?.phase).toBe('dispatch_intent');
      return original(...args);
    });
    const recovered = createRegistryInteractionBroker(f.registry);
    await recovered.recover(); await recovered.recover();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0]?.[0]).toContain('Alice');
    expect(f.store.snapshot().continuations[0]?.phase).toBe('completed');
    await recovered.drain();
  });

  it('requires approval for a custom tool that shadows a safe built-in name', async () => {
    const f = await fixture(pi => pi.registerTool({ name: 'read', label: 'External read', description: 'Untrusted fixture tool',
      parameters: Type.Object({}), execute: async () => ({ content: [{ type: 'text', text: 'fixture' }] }) }));
    const client = await f.client(); f.registry.tightenPolicy(f.root.sessionId);
    expect(f.root.tools.requiresApproval(f.registry.getPolicy(f.root.sessionId), 'read')).toBe(true);
    type Handler = (event: { toolName: string; toolCallId: string; input: object }, context: { sessionManager: typeof f.root.runtime.session.sessionManager; signal: AbortSignal }) => Promise<unknown>;
    let handler!: Handler;
    await f.broker.approvalExtension(f.registry).factory({ on: (name: string, value: unknown) => { if (name === 'tool_call') handler = value as Handler; } } as unknown as ExtensionAPI);
    const pending = handler({ toolName: 'read', toolCallId: 'read-call', input: {} }, { sessionManager: f.root.runtime.session.sessionManager, signal: new AbortController().signal });
    const interaction = f.published.at(-1)!;
    expect(interaction.request.kind).toBe('tool_approval');
    await client.request('interaction.answer', { interactionId: interaction.id, answer: { kind: 'tool_approval', optionId: 'allow-once' } }, { session: f.root.sessionId });
    await expect(pending).resolves.toBeUndefined();
  });

  it('does not publish an interaction when durable admission fails', async () => {
    const f = await fixture();
    vi.spyOn(f.store, 'putInteraction').mockImplementation(() => { throw new Error('storage failure'); });
    expect(() => f.broker.request({ kind: 'input', title: 'Not committed' }, f.scope)).toThrow('storage failure');
    expect(f.published).toHaveLength(0);
    expect(f.broker.pending()).toHaveLength(0);
  });

  it('keeps a provably undispatched continuation ready after a busy preflight', async () => {
    const f = await fixture(); const client = await f.client();
    const waiting = f.broker.request({ kind: 'input', title: 'Name?' }, f.scope, { deferrable: true });
    const id = f.published.at(-1)!.id;
    await f.broker.drain(); await waiting;
    await client.request('interaction.answer', { interactionId: id, answer: { kind: 'input', text: 'Alice' } }, { session: f.root.sessionId });
    let busy = true;
    const recovered = new InteractionBroker({ store: f.store, publish() {}, resume: async (_session, _answer, _id, dispatch) => {
      if (busy) throw Object.assign(new Error('busy'), { code: 'busy' });
      dispatch();
    } });
    await recovered.recover();
    expect(f.store.snapshot().continuations[0]?.phase).toBe('ready');
    busy = false;
    await recovered.recover();
    expect(f.store.snapshot().continuations[0]?.phase).toBe('completed');
    await recovered.drain();
  });

  it('rejects a late answer without reviving a cancelled question', async () => {
    const f = await fixture(); const client = await f.client();
    const waiting = f.broker.request({ kind: 'input', title: 'Cancelled' }, f.scope);
    const id = f.published.at(-1)!.id;
    f.broker.cancel(id, 'abort');
    await expect(waiting).resolves.toEqual({ state: 'cancelled', reason: 'abort' });
    expect((await client.request('interaction.answer', { interactionId: id, answer: { kind: 'input', text: 'late' } }, { session: f.root.sessionId })).outcome).toBe('rejected');
    expect(f.store.snapshot().interactions[0]?.state).toBe('cancelled');
  });

  it('serializes multiple deferred continuations for the same session', async () => {
    const f = await fixture(); const client = await f.client();
    const waiting = ['First?', 'Second?'].map(question => f.broker.request({ kind: 'input', title: question }, f.scope, { deferrable: true }));
    const ids = f.published.map(item => item.id);
    await f.broker.drain(); await Promise.all(waiting);
    for (const id of ids) await client.request('interaction.answer', { interactionId: id,
      answer: { kind: 'input', text: 'answer' } }, { session: f.root.sessionId });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    let calls = 0;
    const recovered = new InteractionBroker({ store: f.store, publish() {}, resume: async (_session, _answer, _id, dispatch) => {
      dispatch();
      if (++calls === 1) { signalStarted(); await held; }
    } });
    const recovery = recovered.recover();
    try {
      await Promise.race([started, recovery]);
      expect(calls).toBe(1);
      release(); await recovery;
      expect(calls).toBe(2);
      expect(f.store.snapshot().continuations.every(item => item.phase === 'completed')).toBe(true);
    } finally { release(); await recovery; await recovered.drain(); }
  });
});
