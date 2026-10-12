import { afterEach, describe, expect, it, vi } from 'vitest';
import { PREWALK_REVIEW_PRESENTER } from '@felan-ai/ext-prewalk/tui';
import type { Interaction } from '@felan-ai/session-protocol';
import { SessionClient } from '../src/client/client.js';
import { ClientInteractionPresenters, type InteractionPresenterUi } from '../src/client/presenters.js';
import { registerPrewalkPresenter } from '../src/client/prewalk-presenter.js';
import { createRegistryInteractionBroker } from '../../daemon/src/daemon/broker.js';
import { createSessionExtensionUi, SESSION_UI_PRESENTERS } from '../../daemon/src/daemon/extension-ui.js';
import { DaemonConfiguration } from '../../daemon/src/daemon/configuration.js';
import { SessionServer } from '../../daemon/src/daemon/server.js';
import { serverFixture } from '../../daemon/test/fixtures/server.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const f = await serverFixture({ now: () => Date.now() });
  const broker = createRegistryInteractionBroker(f.registry, { presenters: SESSION_UI_PRESENTERS });
  const bridge = createSessionExtensionUi({ broker, scope: { kind: 'session', session: f.root.sessionId, root: f.root.rootSessionId } });
  const configuration = new DaemonConfiguration({ agentDir: f.owner.target.agentDir, definitions: [], assertCurrent: () => f.registry.assertAdmission() });
  const server = new SessionServer({ registry: f.registry, configuration, models: f.root.runtime.session.modelRuntime, version: 'fixture', broker });
  const clients: SessionClient[] = [];
  cleanups.push(async () => { for (const client of clients) client.close(); server.close(); bridge.dispose(); await broker.drain(); await f.dispose(); });
  bridge.activate(update => f.registry.projection(f.root.sessionId).setPresentation(update));
  await server.start();
  const ui = { custom: vi.fn(async (): Promise<unknown> => ({ action: 'Approve plan' })), notify: vi.fn() };
  const presenters = new ClientInteractionPresenters(ui as unknown as InteractionPresenterUi);
  registerPrewalkPresenter(presenters, ui as unknown as Pick<InteractionPresenterUi, 'custom'>);
  async function connect(version = '1') {
    const client = new SessionClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: f.owner.target.namespaceId, storeRoots: [f.directory] },
      expected: f.owner.identity, clientVersion: 'fixture', kind: 'tui', interactionKinds: presenters.interactionKinds,
      presenters: presenters.presenters.map(value => value.id === PREWALK_REVIEW_PRESENTER.id ? { ...value, version } : value), requestTimeoutMs: 1000, retries: 0 });
    clients.push(client); await client.connect(); await client.attach(f.root.sessionId); return client;
  }
  const review = (plan: string, signal?: AbortSignal) => bridge.prewalk.review({ mode: 'print', ui: bridge.context }, plan, signal);
  async function received(client: SessionClient): Promise<Interaction> {
    const id = f.store.snapshot().interactions.at(-1)!.id;
    await vi.waitFor(() => expect(client.getAttachment(f.root.sessionId)?.state.snapshot?.interactions.some(item => item.id === id)).toBe(true));
    return client.getAttachment(f.root.sessionId)!.state.snapshot!.interactions.find(item => item.id === id)!;
  }
  return { ...f, broker, bridge, ui, presenters, connect, review, received };
}

describe('Prewalk broker presenter', () => {
  it.each([
    { name: 'Unicode', plan: '界'.repeat(32_000) },
    { name: 'astral Unicode', plan: '😀'.repeat(16_000) },
    { name: 'escaped control text', plan: '\u0000'.repeat(32_000) },
  ])('keeps the complete valid plan over the wire: $name', async ({ plan }) => {
    const f = await fixture(); const client = await f.connect();
    expect(client.capabilities?.presenters).toContainEqual(PREWALK_REVIEW_PRESENTER);
    const pending = f.review(plan);
    const item = await f.received(client);
    expect(item.request).toMatchObject({ kind: 'custom', data: null, document: plan });
    const result = await f.presenters.present(item, new AbortController().signal);
    expect(result.state).toBe('answered');
    if (result.state !== 'answered') throw new Error('Expected a presented answer');
    expect((await client.request('interaction.answer', { interactionId: item.id, answer: result.answer }, { session: f.root.sessionId })).outcome).toBe('accepted');
    await expect(pending).resolves.toEqual({ action: 'Approve plan' });
  });

  it('validates action data before consuming the question and keeps feedback across reconnect', async () => {
    const f = await fixture(); const first = await f.connect();
    const pending = f.review('# Plan'); const item = await f.received(first);
    expect((await first.request('interaction.answer', { interactionId: item.id, answer: { kind: 'custom', presenter: PREWALK_REVIEW_PRESENTER, data: { action: 'invalid' } } }, { session: f.root.sessionId })).outcome).toBe('rejected');
    expect(f.broker.pending()).toHaveLength(1);
    first.close(); const next = await f.connect();
    f.ui.custom.mockResolvedValueOnce({ action: 'Provide feedback', feedback: 'Preserve the API.' });
    const result = await f.presenters.present(await f.received(next), new AbortController().signal);
    if (result.state !== 'answered') throw new Error('Expected feedback');
    await next.request('interaction.answer', { interactionId: item.id, answer: result.answer }, { session: f.root.sessionId });
    await expect(pending).resolves.toEqual({ action: 'Provide feedback', feedback: 'Preserve the API.' });
  });

  it('rejects incompatible presentation and oversized plans without leaving questions behind', async () => {
    const f = await fixture(); await f.connect('2');
    await expect(f.review('# Plan')).rejects.toMatchObject({ code: 'unsupported' });
    await expect(f.review('x'.repeat(32_001))).rejects.toThrow();
    expect(f.broker.pending()).toEqual([]);
  });

  it('does not treat cancellation as plan approval', async () => {
    const f = await fixture(); const client = await f.connect();
    const pending = f.review('# Plan'); const item = await f.received(client);
    await client.request('interaction.answer', { interactionId: item.id, answer: { cancelled: true, reason: 'user' } }, { session: f.root.sessionId });
    await expect(pending).resolves.toBeUndefined();
  });
});
