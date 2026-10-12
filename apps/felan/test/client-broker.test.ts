import { afterEach, describe, expect, it, vi } from 'vitest';
import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionContext } from '@felan-ai/agent-core';
import { LIMITS, RUNTIME_UI_PRESENTER, parseInteraction, type Interaction } from '@felan-ai/session-protocol';
import { SessionClient } from '../src/client/client.js';
import { ClientInteractionPresenters, type InteractionPresenterUi } from '../src/client/presenters.js';
import { createSessionExtensionUi } from '../../daemon/src/daemon/extension-ui.js';
import { createLocalBrowserAuthorizationHost } from '../../daemon/src/browser/authorization-host.js';
import type { AgentRuntime } from '@felan-ai/agent-core';
import { InteractionBroker, createRegistryInteractionBroker } from '../../daemon/src/daemon/broker.js';
import { DaemonConfiguration } from '../../daemon/src/daemon/configuration.js';
import { DaemonControlStore } from '../../daemon/src/daemon/control-store.js';
import { SessionServer } from '../../daemon/src/daemon/server.js';
import { serverFixture } from '../../daemon/test/fixtures/server.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(extension?: (pi: ExtensionAPI) => void, presenters: Array<{ id: string; version: string }> = []) {
  const f = await serverFixture({ now: () => Date.now(), ...(extension ? { extension } : {}) });
  const published: Interaction[] = [];
  const resumed = vi.fn(async (_session: string, _answer: unknown, _id: string, dispatch: () => void) => { dispatch(); });
  const broker = new InteractionBroker({ store: f.store, presenters, now: () => Date.now(), resume: resumed,
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
  async function client(kind: 'tui' | 'acp' | 'headless' = 'tui', attach = true, clientPresenters: Array<{ id: string; version: string }> = []) {
    const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
      expected: f.owner.identity, clientVersion: 'fixture', kind, presenters: clientPresenters,
      interactionKinds: ['select', 'confirm', 'input', 'ask_user', 'tool_approval', 'oauth', 'trust', 'dependency', ...(clientPresenters.length ? ['custom' as const] : [])],
      requestTimeoutMs: 1000, retries: 0 });
    clients.push(client);
    await client.connect();
    if (attach) expect((await client.attach(f.root.sessionId)).outcome).toBe('accepted');
    return client;
  }
  return { ...f, broker, published, resumed, server, scope, client };
}

describe('InteractionBroker', () => {
  it('requires a local TUI and committed browser consent before native inspection', async () => {
    const f = await fixture();
    const bridge = createSessionExtensionUi({ broker: f.broker, scope: f.scope }); bridge.activate(() => {});
    cleanups.push(async () => bridge.dispose());
    const inspect = vi.fn(async () => ({ state: 'ready' as const, processId: 1, connection: { port: 1234, webSocketPath: '/private' } }));
    const lease = { connection: { port: 1234, webSocketPath: '/private' }, signal: new AbortController().signal, connected: true, close: vi.fn(async () => {}) };
    const attach = vi.fn(async () => ({ ready: true }));
    const host = createLocalBrowserAuthorizationHost({ runtime: { kind: 'host' } as AgentRuntime, presentation: bridge.browser, inspect, createLease: async () => lease });
    const context = { mode: 'print', hasUI: true, ui: bridge.context } as unknown as ExtensionContext;
    const request = { origin: 'https://example.test', reason: 'Read the report.', extensionContext: context, signal: new AbortController().signal, attach };
    const acp = await f.client('acp'); await expect(host.authorize(request)).resolves.toMatchObject({ status: 'unavailable' });
    expect(inspect).not.toHaveBeenCalled();
    const client = await f.client('tui'); const pending = host.authorize(request);
    await vi.waitFor(() => expect(client.getInteractions()).toHaveLength(1));
    const item = client.getInteractions()[0]!;
    expect(item.scope).toEqual({ kind: 'host' }); expect(item.request).toMatchObject({ title: expect.stringContaining('Read the report.') });
    expect(acp.getInteractions()).toEqual([]);
    expect((await acp.request('interaction.answer', { interactionId: item.id, answer: { kind: 'select', choices: ['once'] } })).outcome).toBe('rejected');
    expect(inspect).not.toHaveBeenCalled();
    await client.request('interaction.answer', { interactionId: item.id, answer: { kind: 'select', choices: ['once'] } });
    await expect(pending).resolves.toEqual({ status: 'authorized' }); expect(attach).toHaveBeenCalledOnce();
  });

  it('reports unavailable OAuth presentation before creating a dialog', async () => {
    const f = await fixture();
    const bridge = createSessionExtensionUi({ broker: f.broker, scope: f.scope }); bridge.activate(() => {});
    cleanups.push(async () => bridge.dispose());
    await expect(bridge.mcp({ server: 'server', url: 'https://oauth.example.test/authorize', signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'unsupported' });
    expect(f.broker.pending()).toEqual([]);
  });

  it('keeps local OAuth pending after opening and never persists its authorization URL', async () => {
    const f = await fixture(); const client = await f.client();
    const bridge = createSessionExtensionUi({ broker: f.broker, scope: f.scope }); bridge.activate(() => {});
    cleanups.push(async () => bridge.dispose());
    const control = new AbortController();
    const waiting = bridge.mcp({ server: 'private-server', url: 'https://oauth.example.test/authorize?state=private-state', signal: control.signal });
    await vi.waitFor(() => expect(client.getInteractions()).toHaveLength(1));
    const item = client.getInteractions()[0]!; expect(item.scope).toEqual({ kind: 'host' });
    const openOAuthUrl = vi.fn(async () => {});
    const select = vi.fn(async (_title, _choices, options: { signal: AbortSignal }) => {
      await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }));
      return undefined;
    });
    const presenters = new ClientInteractionPresenters({ select, notify: vi.fn() } as unknown as InteractionPresenterUi, { openOAuthUrl });
    const shown = presenters.present(item, control.signal);
    await vi.waitFor(() => expect(select).toHaveBeenCalledOnce());
    expect(openOAuthUrl).toHaveBeenCalledOnce(); expect(f.broker.pending()).toHaveLength(1);
    expect(JSON.stringify(f.store.snapshot())).not.toContain('private-state');
    control.abort(); await waiting; await expect(shown).resolves.toMatchObject({ state: 'cancelled', reason: 'abort' });
    expect(f.broker.pending()).toEqual([]);
  });

  it('cancels host OAuth when the last eligible local client disconnects', async () => {
    const f = await fixture(); const client = await f.client();
    const bridge = createSessionExtensionUi({ broker: f.broker, scope: f.scope }); bridge.activate(() => {});
    cleanups.push(async () => bridge.dispose());
    const waiting = bridge.mcp({ server: 'server', url: 'https://oauth.example.test/authorize', signal: new AbortController().signal });
    await vi.waitFor(() => expect(client.getInteractions()).toHaveLength(1)); client.close();
    await waiting; expect(f.broker.pending()).toEqual([]); expect(f.store.snapshot().interactions).toEqual([]);
  });

  it('fails closed when a custom validator violates its synchronous return contract', async () => {
    const presenter = { id: 'fixture.invalid-validator', version: '1' };
    const f = await fixture(undefined, [{ ...presenter, validateAnswer: () => 'invalid return' } as never]);
    const client = await f.client('tui', true, [presenter]);
    const waiting = f.broker.request({ kind: 'custom', presenter, data: {} }, f.scope);
    const item = f.broker.pending()[0]!;
    expect((await client.request('interaction.answer', { interactionId: item.id, answer: { kind: 'custom', presenter, data: {} } }, { session: f.root.sessionId })).outcome).toBe('rejected');
    expect(f.broker.pending()).toHaveLength(1);
    f.broker.cancel(item.id, 'abort');
    await expect(waiting).resolves.toEqual({ state: 'cancelled', reason: 'abort' });
  });

  it('negotiates exact registered custom versions and rejects an incompatible responder', async () => {
    const presenter = { id: 'fixture.review', version: '1' };
    const f = await fixture(undefined, [presenter]);
    const compatible = await f.client('tui', true, [presenter]);
    const incompatible = await f.client('tui', true, [{ ...presenter, version: '2' }]);
    expect(compatible.capabilities?.presenters).toEqual([presenter]);
    expect(incompatible.capabilities?.presenters).toEqual([]);
    const waiting = f.broker.request({ kind: 'custom', presenter, data: { title: 'Review' } }, f.scope);
    const item = f.published.at(-1)!;
    const params = { interactionId: item.id, answer: { kind: 'custom', presenter, data: { approved: false } } } as const;
    expect((await incompatible.request('interaction.answer', params, { session: f.root.sessionId })).outcome).toBe('rejected');
    expect(f.broker.pending()).toContainEqual(item);
    expect((await compatible.request('interaction.answer', params, { session: f.root.sessionId })).outcome).toBe('accepted');
    await expect(waiting).resolves.toEqual({ state: 'answered', answer: params.answer });
  });

  it('does not let a client capability claim register a custom contract', async () => {
    const presenter = { id: 'fixture.unregistered', version: '1' };
    const f = await fixture();
    const client = await f.client('tui', true, [presenter]);
    expect(client.capabilities?.interactionKinds).not.toContain('custom');
    expect(client.capabilities?.presenters).toEqual([]);
    await expect(f.broker.request({ kind: 'custom', presenter, data: {} }, f.scope))
      .resolves.toEqual({ state: 'cancelled', reason: 'unsupported' });
    expect(f.broker.pending()).toEqual([]);
    expect(f.store.snapshot().interactions).toEqual([]);
  });

  it('rejects unregistered versions even when other custom contracts are installed', async () => {
    const presenter = { id: 'fixture.review', version: '1' };
    const f = await fixture(undefined, [presenter]);
    await expect(f.broker.request({ kind: 'custom', presenter: { ...presenter, version: '2' }, data: {} }, f.scope))
      .resolves.toEqual({ state: 'cancelled', reason: 'unsupported' });
    expect(f.broker.pending()).toEqual([]);
  });

  it('requires a compatible client at custom-dialog creation but preserves an existing dialog across detach', async () => {
    const presenter = { id: 'fixture.review', version: '1' };
    const f = await fixture(undefined, [presenter]);
    await f.client('tui', true, [{ ...presenter, version: '2' }]);
    await expect(f.broker.request({ kind: 'custom', presenter, data: {} }, f.scope))
      .resolves.toEqual({ state: 'cancelled', reason: 'unsupported' });
    expect(f.broker.pending()).toEqual([]);
    const first = await f.client('tui', true, [presenter]);
    const waiting = f.broker.request({ kind: 'custom', presenter, data: {} }, f.scope);
    const item = f.published.at(-1)!;
    first.close();
    const next = await f.client('tui', true, [presenter]);
    expect(next.getAttachment(f.root.sessionId)?.state.snapshot?.interactions).toContainEqual(expect.objectContaining({ id: item.id, state: 'waiting' }));
    expect((await next.request('interaction.answer', { interactionId: item.id, answer: { kind: 'custom', presenter, data: {} } }, { session: f.root.sessionId })).outcome).toBe('accepted');
    await expect(waiting).resolves.toMatchObject({ state: 'answered' });
  });

  it('negotiates runtime UI state independently from interactive custom contracts', async () => {
    const f = await fixture();
    const client = await f.client('tui', true, [RUNTIME_UI_PRESENTER]);
    expect(client.capabilities?.presenters).toEqual([RUNTIME_UI_PRESENTER]);
    expect(client.capabilities?.interactionKinds).not.toContain('custom');
  });

  it('validates and isolates the fixed daemon presenter registration', async () => {
    const input = [{ id: 'fixture.review', version: '1' }];
    const f = await fixture(undefined, input);
    input[0]!.version = '2';
    f.broker.presenters[0]!.version = '3';
    f.broker.interactionKinds.splice(0);
    expect(f.broker.presenters).toEqual([{ id: 'fixture.review', version: '1' }]);
    expect(f.broker.interactionKinds).toContain('custom');
    const options = { store: f.store, publish() {} };
    expect(() => new InteractionBroker({ ...options, presenters: [RUNTIME_UI_PRESENTER] })).toThrow('reserved');
    expect(() => new InteractionBroker({ ...options, presenters: [input[0]!, input[0]!] })).toThrow('duplicated');
    expect(() => new InteractionBroker({ ...options, presenters: [{ id: 'bad', version: 0 }] as never })).toThrow();
    expect(() => new InteractionBroker({ ...options, presenters: Array.from({ length: LIMITS.catalogEntries }, () => input[0]!) })).toThrow('capacity');
    const registryBroker = createRegistryInteractionBroker(f.registry, { presenters: [{ id: 'factory', version: '1' }] });
    cleanups.push(() => registryBroker.drain());
    expect(registryBroker.presenters).toEqual([{ id: 'factory', version: '1' }]);
  });

  it('cancels a recovered custom question whose daemon contract is no longer installed', async () => {
    const f = await fixture();
    const item = parseInteraction({ id: 'orphan', state: 'waiting', scope: f.scope, createdAt: Date.now(), eligibleClientKinds: ['tui'],
      request: { kind: 'custom', presenter: { id: 'removed', version: '1' }, data: {} } });
    f.store.putInteraction(item);
    await f.broker.recover();
    expect(f.broker.pending()).toEqual([]);
    expect(f.store.snapshot().interactions[0]).toMatchObject({ state: 'cancelled', result: { reason: 'unsupported' } });
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

  it('requires a current session attachment and rejects headless answers', async () => {
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
    const waiting = f.broker.request({ kind: 'ask_user', questions: [{ id: 'q', question: 'Name?' }] }, f.scope);
    const id = f.published.at(-1)!.id;
    const beforeDrain = Date.now();
    await f.broker.drain();
    await expect(waiting).resolves.toEqual({ state: 'deferred', interactionId: id });
    expect(f.store.snapshot().interactions[0]).toMatchObject({ state: 'deferred', expiresAt: expect.any(Number) });
    expect(f.store.snapshot().interactions[0]!.expiresAt).toBeGreaterThanOrEqual(beforeDrain + 30 * 60 * 1000);
    expect(f.store.snapshot().interactions[0]!.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * 60 * 1000);
    expect((await client.request('interaction.answer', { interactionId: id, answer: { kind: 'ask_user', answers: [{ questionId: 'q', choices: [], text: 'Alice' }] } }, { session: f.root.sessionId })).outcome).toBe('accepted');
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
    const waiting = f.broker.request({ kind: 'ask_user', questions: [{ id: 'q', question: 'Name?' }] }, f.scope);
    const id = f.published.at(-1)!.id;
    await f.broker.drain(); await waiting;
    await client.request('interaction.answer', { interactionId: id, answer: { kind: 'ask_user', answers: [{ questionId: 'q', choices: [], text: 'Alice' }] } }, { session: f.root.sessionId });
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

  it('limits host trust answers to local TUI clients', async () => {
    const f = await fixture();
    const acp = await f.client('acp', false);
    const tui = await f.client('tui', false);
    const waiting = f.broker.request({ kind: 'trust', cwd: f.cwd, message: 'Trust this workspace?' }, { kind: 'host' });
    const id = f.published.at(-1)!.id;
    await vi.waitFor(() => expect(tui.getInteractions()).toContainEqual(expect.objectContaining({ id })));
    expect(acp.getInteractions()).toHaveLength(0);
    const params = { interactionId: id, answer: { kind: 'trust', trusted: true } } as const;
    expect((await acp.request('interaction.answer', params)).outcome).toBe('rejected');
    expect((await tui.request('interaction.answer', params)).outcome).toBe('accepted');
    await expect(waiting).resolves.toMatchObject({ state: 'answered' });
  });

  it('keeps OAuth details out of persistent control state', async () => {
    const f = await fixture();
    const client = await f.client();
    const waiting = f.broker.request({ kind: 'oauth', provider: 'fixture', provisioningId: 'setup', url: 'https://example.invalid/private', instructions: 'Complete sign-in' }, f.scope);
    expect(f.store.snapshot().interactions).toHaveLength(0);
    await vi.waitFor(() => expect(client.getInteractions()).toHaveLength(1));
    await f.broker.drain();
    await expect(waiting).resolves.toEqual({ state: 'cancelled', reason: 'drain' });
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
    const waiting = f.broker.askUserHost().ask({ questions: [{ id: 'q', question: 'Which?', header: 'Choice',
      options: [{ title: 'First' }, { title: 'Second' }], allowMultiple: false, allowFreeform: true, allowComment: true }] },
    { requestId: 'tool-call', sessionId: f.root.sessionId, signal: new AbortController().signal, extensionContext: {} as ExtensionContext, reportProgress() {} });
    const interaction = f.published.at(-1)!;
    await client.request('interaction.answer', { interactionId: interaction.id, answer: { kind: 'ask_user',
      answers: [{ questionId: 'q', choices: ['choice-1'], comment: 'selected' }] } }, { session: f.root.sessionId });
    await expect(waiting).resolves.toEqual({ status: 'answered', answers: [{ questionId: 'q', response: { kind: 'selection', selections: ['Second'], comment: 'selected' } }] });
  });

  it('adapts a freeform ask-user question with no options', async () => {
    const f = await fixture(); const client = await f.client();
    const waiting = f.broker.askUserHost().ask({ questions: [{ id: 'q', question: 'Name?', header: 'Name',
      options: [], allowMultiple: false, allowFreeform: true, allowComment: false }], timeout: 5000.5, overlayToggleKey: null, commentToggleKey: null },
    { requestId: 'tool-call', sessionId: f.root.sessionId, signal: new AbortController().signal, extensionContext: {} as ExtensionContext, reportProgress() {} });
    const interaction = f.published.at(-1)!;
    expect(interaction.expiresAt! - interaction.createdAt).toBe(5001);
    expect(interaction.request).toMatchObject({ overlayToggleKey: 'off', commentToggleKey: 'off' });
    expect(interaction.request).toMatchObject({ kind: 'ask_user', questions: [expect.not.objectContaining({ options: expect.anything() })] });
    await client.request('interaction.answer', { interactionId: interaction.id, answer: { kind: 'ask_user',
      answers: [{ questionId: 'q', choices: [], text: 'Alice' }] } }, { session: f.root.sessionId });
    await expect(waiting).resolves.toEqual({ status: 'answered', answers: [{ questionId: 'q', response: { kind: 'freeform', text: 'Alice' } }] });
  });

  it('resumes a deferred answer through the real registry only after dispatch is durable', async () => {
    const f = await fixture(); const client = await f.client();
    const waiting = f.broker.request({ kind: 'ask_user', questions: [{ id: 'q', question: 'Name?' }] }, f.scope);
    const id = f.published.at(-1)!.id;
    await f.broker.drain(); await waiting;
    await client.request('interaction.answer', { interactionId: id, answer: { kind: 'ask_user', answers: [{ questionId: 'q', choices: [], text: 'Alice' }] } }, { session: f.root.sessionId });
    const original = f.root.runtime.session.prompt.bind(f.root.runtime.session);
    const prompt = vi.spyOn(f.root.runtime.session, 'prompt').mockImplementation(async (...args) => {
      expect(f.store.snapshot().continuations[0]?.phase).toBe('dispatch_intent');
      return original(...args);
    });
    const recovered = createRegistryInteractionBroker(f.registry);
    await recovered.recover(); await recovered.recover();
    expect(prompt).toHaveBeenCalledTimes(1);
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
    const waiting = f.broker.request({ kind: 'ask_user', questions: [{ id: 'q', question: 'Name?' }] }, f.scope);
    const id = f.published.at(-1)!.id;
    await f.broker.drain(); await waiting;
    await client.request('interaction.answer', { interactionId: id, answer: { kind: 'ask_user', answers: [{ questionId: 'q', choices: [], text: 'Alice' }] } }, { session: f.root.sessionId });
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

  it('does not advertise or persist custom interactions without a registered presenter', async () => {
    const f = await fixture(); const client = await f.client();
    expect(f.broker.interactionKinds).not.toContain('custom');
    expect(client.capabilities?.interactionKinds).not.toContain('custom');
    await expect(f.broker.request({ kind: 'custom', presenter: { id: 'external.panel', version: '1' }, data: {} }, f.scope))
      .resolves.toEqual({ state: 'cancelled', reason: 'unsupported' });
    expect(f.published).toHaveLength(0);
    expect(f.broker.pending()).toHaveLength(0);
  });

  it('does not expose OAuth to an ACP-only attachment', async () => {
    const f = await fixture(); const client = await f.client('acp');
    await expect(f.broker.request({ kind: 'oauth', provider: 'fixture', provisioningId: 'setup',
      url: 'https://example.invalid/private', instructions: 'Complete sign-in' }, f.scope))
      .resolves.toEqual({ state: 'cancelled', reason: 'unsupported' });
    expect(client.getInteractions()).toHaveLength(0);
    expect(f.broker.pending()).toHaveLength(0);
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
    const waiting = ['First?', 'Second?'].map(question => f.broker.request({ kind: 'ask_user', questions: [{ id: 'q', question }] }, f.scope));
    const ids = f.published.map(item => item.id);
    await f.broker.drain(); await Promise.all(waiting);
    for (const id of ids) await client.request('interaction.answer', { interactionId: id,
      answer: { kind: 'ask_user', answers: [{ questionId: 'q', choices: [], text: 'answer' }] } }, { session: f.root.sessionId });
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
