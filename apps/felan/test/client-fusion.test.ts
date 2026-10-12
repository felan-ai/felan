import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Theme } from '@felan-ai/agent-core';
import type { FusionReview, FusionReviewActions } from '@felan-ai/ext-fusion';
import type { Interaction, JsonValue } from '@felan-ai/session-protocol';
import { ClientInteractionPresenters, type InteractionPresenterUi } from '../src/client/presenters.js';
import { registerFusionPresenters } from '../src/client/fusion-presenter.js';
import { SessionClient } from '../src/client/client.js';
import { createRegistryInteractionBroker } from '../../daemon/src/daemon/broker.js';
import { createSessionExtensionUi, SESSION_UI_PRESENTERS } from '../../daemon/src/daemon/extension-ui.js';
import { DaemonConfiguration } from '../../daemon/src/daemon/configuration.js';
import { SessionServer } from '../../daemon/src/daemon/server.js';
import { gate, serverFixture } from '../../daemon/test/fixtures/server.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text,
  underline: (text: string) => text, strikethrough: (text: string) => text } as unknown as Theme;
const models = [{ reference: 'one/model', label: 'One' }, { reference: 'two/model', label: 'Two' }];
const initialReview: FusionReview = { prompt: 'Compare', participants: models.map(model => model.reference), fusionModel: 'one/model',
  answers: models.map(model => ({ model: model.reference, text: 'answer', durationMs: 1 })),
  comparison: { model: 'one/model', text: 'comparison', durationMs: 1 }, failures: [{ model: 'two/model', message: 'failed' }], updatedAt: 1 };

async function fixture(review = initialReview, overrides: Partial<FusionReviewActions> = {}) {
  let broker!: ReturnType<typeof createRegistryInteractionBroker>;
  let bridge!: ReturnType<typeof createSessionExtensionUi>;
  let finished = false; let failure: unknown; let configured: unknown;
  const actions = { fuse: vi.fn(async () => {}), retryParticipants: vi.fn(async () => {}), retryComparison: vi.fn(async () => {}),
    retryFusion: vi.fn(async () => {}), cancel: vi.fn(), ...overrides };
  const f = await serverFixture({ now: () => Date.now(), extensionUi(context, registry) {
    broker ??= createRegistryInteractionBroker(registry, { presenters: SESSION_UI_PRESENTERS });
    bridge = createSessionExtensionUi({ broker, scope: { kind: 'session', session: context.sessionManager.getSessionId(), root: context.rootSessionId } });
    return bridge;
  }, extension(pi) {
    pi.registerCommand('fusion-fixture', { description: 'Review fixture', handler: async (_args, ctx) => {
      try { await bridge.fusion.review(ctx, () => review, actions); } catch (error) { failure = error; } finally { finished = true; }
    } });
    pi.registerCommand('fusion-picker-fixture', { description: 'Picker fixture', handler: async (_args, ctx) => {
      try { configured = await bridge.fusion.configure(ctx, models, models.map(model => model.reference), 'inherit'); }
      catch (error) { failure = error; } finally { finished = true; }
    } });
  } });
  const configuration = new DaemonConfiguration({ agentDir: f.owner.target.agentDir, definitions: [], assertCurrent: () => f.registry.assertAdmission() });
  const server = new SessionServer({ registry: f.registry, configuration, models: f.root.runtime.session.modelRuntime, version: 'fixture', broker });
  const clients: SessionClient[] = [];
  cleanups.push(async () => { for (const client of clients) client.close(); bridge.dispose(); server.close(); await broker.drain(); await f.dispose(); });
  bridge.activate(update => f.registry.projection(f.root.sessionId).setPresentation(update)); await server.start();
  let keys = ['\r'];
  const ui = { notify: vi.fn(), custom: vi.fn((factory: (...args: any[]) => any) => new Promise<unknown>(resolve => {
    const panel = factory({ requestRender: vi.fn(), terminal: { rows: 30 } }, theme, {}, resolve);
    for (const key of keys) panel.handleInput(key);
  })) };
  const presenters = new ClientInteractionPresenters(ui as unknown as InteractionPresenterUi);
  registerFusionPresenters(presenters, ui as unknown as Pick<InteractionPresenterUi, 'custom' | 'notify'>);
  const connect = async (wrongVersion = false) => {
    const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
      expected: f.owner.identity, clientVersion: 'fixture', kind: 'tui', interactionKinds: presenters.interactionKinds,
      presenters: presenters.presenters.map(p => wrongVersion ? { ...p, version: 'incompatible' } : p), requestTimeoutMs: 1000, retries: 0 });
    clients.push(client); await client.connect(); await client.attach(f.root.sessionId); return client;
  };
  const invoke = async (client: SessionClient, name = 'fusion-fixture') => {
    expect((await client.request('command.invoke', { name, arguments: '' }, { session: f.root.sessionId })).outcome).toBe('accepted');
  };
  const waiting = async (busy?: boolean) => {
    let item: Interaction | undefined;
    await vi.waitFor(() => {
      item = broker.pending().find(item => item.request.kind === 'custom' && (busy === undefined || (item.request.data as { busy?: boolean } | null)?.busy === busy));
      expect(item).toBeDefined();
    }); return item!;
  };
  const answer = async (client: SessionClient, item: Interaction, data: JsonValue) => {
    if (item.request.kind !== 'custom') throw new Error('Expected custom request');
    return client.request('interaction.answer', { interactionId: item.id, answer: { kind: 'custom', presenter: item.request.presenter, data } }, { session: f.root.sessionId });
  };
  return { ...f, broker, actions, presenters, connect, invoke, waiting, answer, setKeys: (next: string[]) => { keys = next; },
    finished: () => finished, failure: () => failure, configured: () => configured };
}

describe('Fusion broker presentation', () => {
  it('presents a complete large structured review and dispatches only the selected action', async () => {
    const review = { ...initialReview, answers: models.map(model => ({ model: model.reference, text: '界'.repeat(30_000), durationMs: 1 })) };
    const f = await fixture(review); const client = await f.connect(); await f.invoke(client);
    const item = await f.waiting(false); expect(item.request).toMatchObject({ document: review });
    const result = await f.presenters.present(item, new AbortController().signal);
    if (result.state !== 'answered') throw new Error('Expected decision');
    expect((await client.request('interaction.answer', { interactionId: item.id, answer: result.answer }, { session: f.root.sessionId })).outcome).toBe('accepted');
    await vi.waitFor(() => expect(f.finished()).toBe(true));
    expect(f.actions.fuse).toHaveBeenCalledOnce(); expect(f.failure()).toBeUndefined();
    expect((await f.answer(client, item, { action: 'fuse' })).outcome).toBe('rejected');
    expect(f.actions.fuse).toHaveBeenCalledOnce();
  });

  it('rejects invalid actions without consuming the review, then survives reattachment', async () => {
    const f = await fixture(); const first = await f.connect(); await f.invoke(first); const item = await f.waiting(false);
    expect((await f.answer(first, item, { action: 'fuse', model: 'outside/model' })).outcome).toBe('rejected');
    expect(f.broker.pending()).toHaveLength(1); first.close(); const next = await f.connect();
    expect(next.getAttachment(f.root.sessionId)?.state.snapshot?.interactions).toContainEqual(expect.objectContaining({ id: item.id, state: 'waiting' }));
    await f.answer(next, item, { action: 'close' }); await vi.waitFor(() => expect(f.finished()).toBe(true));
    expect(f.actions.fuse).not.toHaveBeenCalled();
  });

  it('keeps retry cancellation available and joins the work before the command finishes', async () => {
    const started = gate(); const release = gate();
    const f = await fixture(initialReview, { retryParticipants: async () => { started.resolve(); await release.promise; }, cancel: vi.fn() });
    cleanups.push(async () => { release.resolve(); });
    const client = await f.connect(); await f.invoke(client); await f.answer(client, await f.waiting(false), { action: 'retry_participants' });
    await started.promise; const busy = await f.waiting(true);
    expect((await f.answer(client, busy, { action: 'fuse' })).outcome).toBe('rejected');
    await f.answer(client, busy, { action: 'close' });
    await vi.waitFor(() => expect(f.actions.cancel).toHaveBeenCalled()); expect(f.finished()).toBe(false);
    release.resolve(); await vi.waitFor(() => expect(f.finished()).toBe(true));
  });

  it('finishes a retry and replaces its busy question with an actionable review', async () => {
    const release = gate(); const f = await fixture(initialReview, { retryComparison: () => release.promise });
    cleanups.push(async () => { release.resolve(); });
    const client = await f.connect(); await f.invoke(client); const first = await f.waiting(false);
    await f.answer(client, first, { action: 'retry_comparison' }); const busy = await f.waiting(true);
    release.resolve(); const next = await f.waiting(false); expect(next.id).not.toBe(first.id);
    expect(f.store.snapshot().interactions.find(item => item.id === busy.id)?.state).toBe('cancelled');
    await f.answer(client, next, { action: 'close' }); await vi.waitFor(() => expect(f.finished()).toBe(true));
  });

  it('rejects unadvertised model choices before committing the picker answer', async () => {
    const f = await fixture(); const client = await f.connect(); await f.invoke(client, 'fusion-picker-fixture'); const item = await f.waiting();
    expect((await f.answer(client, item, { participants: ['one/model', 'outside/model'], fusionModel: 'inherit' })).outcome).toBe('rejected');
    f.setKeys(['\x13']); const result = await f.presenters.present(item, new AbortController().signal);
    if (result.state !== 'answered') throw new Error('Expected picker answer');
    await client.request('interaction.answer', { interactionId: item.id, answer: result.answer }, { session: f.root.sessionId });
    await vi.waitFor(() => expect(f.finished()).toBe(true));
    expect(f.configured()).toEqual({ participants: ['one/model', 'two/model'], fusionModel: 'inherit' });
  });

  it('does not create a question or dispatch actions for an incompatible client', async () => {
    const f = await fixture(); const client = await f.connect(true); await f.invoke(client);
    await vi.waitFor(() => expect(f.finished()).toBe(true));
    expect(f.failure()).toMatchObject({ code: 'unsupported' }); expect(f.broker.pending()).toEqual([]);
    expect(f.actions.fuse).not.toHaveBeenCalled();
  });
});
