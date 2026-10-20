import type { Socket } from 'node:net';
import { uuidv7, type UiActionContext, type UiRequestResult } from '@felan-ai/agent-core';
import {
  JsonLineDecoder, encodeFrame, parseInteraction, parseServerEnvelope,
  type Interaction, type Operation, type OperationParams, type OperationResult,
  type Response, type ResponseFor, type ServerEnvelope, type UiActionRequest, type UiDocument, type UiForm,
} from '@felan-ai/session-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRegistryInteractionBroker } from '../src/daemon/broker.js';
import { TestHostConfiguration as DaemonConfiguration } from './fixtures/host-services.js';
import { connectLocalIpc } from '../src/daemon/ipc.js';
import { SessionServer } from '../src/daemon/server.js';
import { protocolTarget } from '../src/daemon/target.js';
import { createUiVocabulary, type UiVocabularyUpdate } from '../src/daemon/ui-vocabulary.js';
import { gate, serverFixture } from './fixtures/server.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch (error) { errors.push(error); }
  }
  vi.restoreAllMocks();
  if (errors.length) throw new AggregateError(errors, 'UI integration fixture cleanup failed.');
});

const form = (hint = false): UiForm => ({
  title: 'Review change', markdown: 'A generic review with explicit actions.', fallback: 'Approve with feedback or cancel.',
  input: { fields: [{ id: 'feedback', kind: 'string', label: 'Feedback', required: true, maxLength: 100 }], defaults: { feedback: 'Suggested' } },
  actions: [
    { id: 'approve', label: 'Approve', target: 'element', outcome: 'submit' },
    { id: 'cancel', label: 'Cancel', target: 'element', outcome: 'cancel' },
  ],
  ...(hint ? { hint: { id: 'unregistered-layout', version: '1' } } : {}),
});
const document = (revision = 1): UiDocument => ({
  id: 'review', kind: 'document', revision, title: 'Review', markdown: 'Generic action input.', fallback: 'Submit feedback.',
  actions: [{ id: 'submit', label: 'Submit', target: 'element', outcome: 'submit', input: form().input }],
});
const action = (elementId: string, revision = 1): UiActionRequest => ({
  elementId, revision, actionId: 'submit', outcome: 'submit', values: { feedback: 'Exact input' },
});

interface WirePeer {
  readonly hello: OperationResult<'hello'>;
  readonly events: ServerEnvelope[];
  request<O extends Operation>(op: O, params: OperationParams<O>, options?: { session?: string; id?: string }): Promise<ResponseFor<O>>;
}

async function fixture() {
  const f = await serverFixture({ now: Date.now });
  const broker = createRegistryInteractionBroker(f.registry);
  const updates: UiVocabularyUpdate[] = [];
  const lifecycle: string[] = [];
  const releases = new Set<() => void>();
  const sockets: Socket[] = [];
  const vocabulary = createUiVocabulary({ canRequest: () => true,
    request: async (definition, options): Promise<UiRequestResult> => {
      if (options.audience !== 'session') return { state: 'cancelled', reason: 'unsupported' };
      const result = await broker.request({ kind: 'form', form: definition },
        { kind: 'session', session: f.root.sessionId, root: f.root.sessionId },
        { signal: options.signal, ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }) });
      if (result.state !== 'answered') return result;
      if (result.answer.kind !== 'form') throw new Error('Unexpected form answer kind.');
      return { state: 'answered', answer: result.answer };
    },
    publish: update => { updates.push(update); f.registry.projection(f.root.sessionId).setPresentation(update); },
  });
  const releaseActions = f.registry.registerUiActions(f.root.sessionId, vocabulary.prepareAction);
  const disposeUi = vi.fn(async () => {
    lifecycle.push('ui-dispose');
    await vocabulary.dispose();
    releaseActions();
  });
  f.registry.registerService(f.root.sessionId, {
    busy: () => false,
    settle: async () => { lifecycle.push('ui-settle'); },
    dispose: disposeUi,
  });
  const server = new SessionServer({
    registry: f.registry, broker, models: f.root.runtime.session.modelRuntime, version: 'ui-fixture', now: Date.now,
    configuration: new DaemonConfiguration({ definitions: [], assertCurrent: () => f.registry.assertAdmission() }),
  });
  cleanups.push(async () => {
    for (const release of releases) release();
    for (const socket of sockets) socket.destroy();
    server.close();
    await broker.drain();
    await server.settleCommands();
    await f.dispose();
  });
  await server.start();

  async function peer(capabilities: NonNullable<OperationParams<'hello'>['capabilities']> = [],
    interactionKinds: OperationParams<'hello'>['interactionKinds'] = ['form']): Promise<WirePeer> {
    const socket = await connectLocalIpc(f.owner.target);
    sockets.push(socket);
    const decoder = new JsonLineDecoder();
    const events: ServerEnvelope[] = [];
    const pending = new Map<string, {
      operation: Operation;
      resolve: (response: Response) => void;
      reject: (error: unknown) => void;
    }>();
    let failure: unknown;
    const fail = (error: unknown) => {
      failure = error;
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    };
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('UI fixture socket closed.')));
    socket.on('data', (bytes: Buffer) => {
      try {
        for (const frame of decoder.push(bytes)) {
          const id = typeof frame === 'object' && frame !== null && 're' in frame ? String(frame.re) : undefined;
          const waiter = id === undefined ? undefined : pending.get(id);
          const parsed = parseServerEnvelope(frame, waiter?.operation);
          if ('re' in parsed) {
            if (!waiter || id === undefined) throw new Error('Unexpected response identity.');
            pending.delete(id);
            waiter.resolve(parsed);
          } else events.push(parsed);
        }
      } catch (error) { fail(error); }
    });
    function request<O extends Operation>(op: O, params: OperationParams<O>, options: { session?: string; id?: string } = {}): Promise<ResponseFor<O>> {
      if (failure) return Promise.reject(failure);
      const id = options.id ?? uuidv7();
      const response = new Promise<ResponseFor<O>>((resolve, reject) => {
        pending.set(id, { operation: op, resolve: response => resolve(response as ResponseFor<O>), reject });
        socket.write(encodeFrame({ v: 1, id, op, params, ...(options.session === undefined ? {} : { session: options.session }) }));
      });
      void response.catch(() => {});
      return response;
    }
    const hello = acceptedResult<'hello'>(await request('hello', {
      clientVersion: 'ui-fixture', protocol: 1, kind: 'tui', target: protocolTarget(f.owner.target),
      capabilities, interactionKinds,
    }));
    return { hello, events, request };
  }

  async function attach(client: WirePeer) {
    return acceptedResult<'attach'>(await client.request('attach', { expected: f.owner.identity }, { session: f.root.sessionId }));
  }
  function hold() { const held = gate(); releases.add(held.resolve); return held; }
  return { ...f, broker, vocabulary, updates, lifecycle, disposeUi, peer, attach, hold, ui: vocabulary.createExtensionUi('fixture') };
}

function acceptedResult<O extends Operation>(response: ResponseFor<O>): OperationResult<O> {
  expect(response.outcome).toBe('accepted');
  if (response.outcome !== 'accepted') throw new Error(`Unexpected ${response.outcome}: ${response.error.code}`);
  return response.result;
}

function receivedInteractions(peer: WirePeer): Interaction[] {
  return peer.events.flatMap(event => 'change' in event && event.change.type === 'interaction.requested' && 'interaction' in event.change
    ? [parseInteraction(event.change.interaction)] : []);
}

function wireDocumentId(updates: UiVocabularyUpdate[]): string {
  const value = updates.find(update => 'kind' in update && update.kind === 'document');
  if (!value) throw new Error('No document was published.');
  return value.id;
}

describe('generic UI over private daemon sockets', () => {
  it('negotiates generic capabilities and refuses actions without ui.action', async () => {
    const f = await fixture();
    const handler = vi.fn(async () => {});
    await f.ui.present(document(), { onAction: handler });
    const legacy = await f.peer();
    const generic = await f.peer(['ui.document', 'ui.action']);
    expect(legacy.hello.operations).not.toContain('ui.action');
    expect(legacy.hello.capabilities).toEqual([]);
    expect(generic.hello.operations).toContain('ui.action');
    expect(generic.hello.capabilities).toEqual(expect.arrayContaining(['ui.document', 'ui.action']));
    expect(generic.hello).not.toHaveProperty('presenters');
    expect(generic.hello.interactionKinds).toContain('form');
    await f.attach(legacy);
    const attached = await f.attach(generic);
    expect(attached.snapshot.presentation).toContainEqual(expect.objectContaining({ kind: 'document', markdown: 'Generic action input.' }));
    const id = uuidv7();
    expect(await legacy.request('ui.action', action(wireDocumentId(f.updates)), { session: f.root.sessionId, id }))
      .toMatchObject({ outcome: 'rejected', error: { code: 'unavailable' } });
    expect(handler).not.toHaveBeenCalled();
    expect(f.store.snapshot().requests.some(request => request.id === id)).toBe(false);
  });

  it.each([false, true])('routes form answers by interaction kind, not presenter hints (hint: %s)', async hinted => {
    const f = await fixture();
    const first = await f.peer([]);
    const second = await f.peer([]);
    const incompatible = await f.peer([], []);
    await Promise.all([f.attach(first), f.attach(second), f.attach(incompatible)]);
    const pending = f.ui.request(form(hinted));
    await vi.waitFor(() => expect(receivedInteractions(first)).toHaveLength(1));
    await vi.waitFor(() => expect(receivedInteractions(second)).toHaveLength(1));
    const interaction = receivedInteractions(first)[0]!;
    expect(interaction).toMatchObject({ request: { kind: 'form', form: form(hinted) } });
    const answer: OperationParams<'interaction.answer'>['answer'] = { kind: 'form', actionId: 'approve', outcome: 'submit', values: { feedback: 'Reviewed' } };
    expect(await incompatible.request('interaction.answer', { interactionId: interaction.id, answer }, { session: f.root.sessionId }))
      .toMatchObject({ outcome: 'rejected', error: { code: 'forbidden' } });
    expect(await first.request('interaction.answer', { interactionId: interaction.id,
      answer: { ...answer, values: {} } }, { session: f.root.sessionId }))
      .toMatchObject({ outcome: 'rejected', error: { code: 'invalid_request' } });
    const commitAnswer = vi.spyOn(f.store, 'answerInteraction');
    const requestId = uuidv7();
    const accepted = await first.request('interaction.answer', { interactionId: interaction.id, answer }, { session: f.root.sessionId, id: requestId });
    acceptedResult(accepted);
    await expect(pending).resolves.toEqual({ state: 'answered', answer });
    expect(await second.request('interaction.answer', { interactionId: interaction.id, answer }, { session: f.root.sessionId }))
      .toMatchObject({ outcome: 'rejected', error: { code: 'already_resolved' } });
    expect(await second.request('interaction.answer', { interactionId: interaction.id, answer }, { session: f.root.sessionId, id: requestId })).toEqual(accepted);
    expect(commitAnswer).toHaveBeenCalledOnce();
    expect(f.store.snapshot().interactions.find(item => item.id === interaction.id))
      .toMatchObject({ state: 'answered', result: answer, responder: first.hello.attachmentId });
    const reconnected = await f.peer([]);
    expect((await f.attach(reconnected)).snapshot.interactions.some(item => item.id === interaction.id)).toBe(false);
    expect(await reconnected.request('interaction.answer', { interactionId: interaction.id, answer }, { session: f.root.sessionId, id: requestId })).toEqual(accepted);
    expect(commitAnswer).toHaveBeenCalledOnce();
  });

  it('validates exact action inputs before intent and executes a duplicated durable action once', async () => {
    const f = await fixture();
    const entered = f.hold();
    const release = f.hold();
    const handler = vi.fn(async (_action: UiActionRequest, _context: UiActionContext) => { entered.resolve(); await release.promise; });
    const handle = await f.ui.present(document(), { onAction: handler });
    const first = await f.peer(['ui.action']);
    const second = await f.peer(['ui.action']);
    await Promise.all([f.attach(first), f.attach(second)]);
    const valid = action(wireDocumentId(f.updates));
    const dispatched = vi.spyOn(f.store, 'markDispatched');
    for (const params of [
      { ...valid, values: {} },
      { ...valid, values: { feedback: 'Exact input', unexpected: 'not declared' } },
      { ...valid, outcome: 'cancel' as const },
      { ...valid, itemId: 'foreign-row' },
    ]) {
      const id = uuidv7();
      expect(await first.request('ui.action', params, { session: f.root.sessionId, id }))
        .toMatchObject({ outcome: 'rejected', error: { code: 'invalid_request' } });
      expect(dispatched).not.toHaveBeenCalledWith(id);
    }
    expect(handler).not.toHaveBeenCalled();
    const admitted = vi.spyOn(f.store, 'admit');
    const id = uuidv7();
    const original = first.request('ui.action', valid, { session: f.root.sessionId, id });
    await entered.promise;
    let duplicateSettled = false;
    const duplicate = second.request('ui.action', valid, { session: f.root.sessionId, id })
      .then(response => { duplicateSettled = true; return response; });
    void duplicate.catch(() => {});
    await vi.waitFor(() => expect(admitted).toHaveBeenCalledTimes(2));
    expect(admitted.mock.calls[1]?.[0]).toMatchObject({ id, op: 'ui.action' });
    acceptedResult<'host.status'>(await second.request('host.status', {}));
    expect(duplicateSettled).toBe(false);
    expect(f.store.snapshot().requests.find(request => request.id === id)?.phase).toBe('dispatch_intent');
    expect(handler).toHaveBeenCalledOnce();
    release.resolve();
    const accepted = await original;
    expect(accepted).toMatchObject({ outcome: 'accepted', result: {} });
    expect(await duplicate).toEqual(accepted);
    expect(handler).toHaveBeenCalledWith({ ...valid, elementId: 'review' }, expect.objectContaining({ requestId: id }));
    expect(dispatched.mock.calls.filter(([requestId]) => requestId === id)).toHaveLength(1);
    await handle.close();
    expect(await second.request('ui.action', valid, { session: f.root.sessionId, id })).toEqual(accepted);
    expect(await first.request('ui.action', { ...valid, values: { feedback: 'Changed' } }, { session: f.root.sessionId, id }))
      .toMatchObject({ outcome: 'rejected', error: { code: 'request_conflict' } });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('rejects stale revisions and foreign or closed IDs before dispatch intent', async () => {
    const f = await fixture();
    const handler = vi.fn(async () => {});
    const handle = await f.ui.present(document(), { onAction: handler });
    const id = wireDocumentId(f.updates);
    const peer = await f.peer(['ui.action']);
    await f.attach(peer);
    const foreignUpdates: UiVocabularyUpdate[] = [];
    const foreign = createUiVocabulary({ canRequest: () => true, request: async () => ({ state: 'cancelled', reason: 'unsupported' }), publish: update => { foreignUpdates.push(update); } });
    cleanups.push(() => foreign.dispose());
    await foreign.createExtensionUi('another-binding').present(document(), { onAction: handler });
    await handle.update(document(2));
    const dispatched = vi.spyOn(f.store, 'markDispatched');
    const invalid = [action(id), action(wireDocumentId(foreignUpdates)), action('review', 2)];
    for (const params of invalid) {
      const requestId = uuidv7();
      expect(await peer.request('ui.action', params, { session: f.root.sessionId, id: requestId }))
        .toMatchObject({ outcome: 'rejected', error: { code: 'stale_request' } });
      expect(dispatched).not.toHaveBeenCalledWith(requestId);
    }
    await handle.close();
    const closedRequest = uuidv7();
    expect(await peer.request('ui.action', action(id, 2), { session: f.root.sessionId, id: closedRequest }))
      .toMatchObject({ outcome: 'rejected', error: { code: 'stale_request' } });
    expect(dispatched).not.toHaveBeenCalledWith(closedRequest);
    expect(handler).not.toHaveBeenCalled();
    expect(dispatched).not.toHaveBeenCalled();
  });

  it('holds the session writer barrier and UI cleanup until an admitted handler settles', async () => {
    const f = await fixture();
    const entered = f.hold();
    const release = f.hold();
    const handler = vi.fn(async () => { f.lifecycle.push('handler-start'); entered.resolve(); await release.promise; f.lifecycle.push('handler-end'); });
    await f.ui.present(document(), { onAction: handler });
    const peer = await f.peer(['ui.action']);
    await f.attach(peer);
    const id = uuidv7();
    const response = peer.request('ui.action', action(wireDocumentId(f.updates)), { session: f.root.sessionId, id });
    await entered.promise;
    let writersSettled = false;
    const writers = f.registry.settleWriters().then(() => { writersSettled = true; });
    const closing = f.registry.close(f.root.sessionId);
    acceptedResult<'host.status'>(await peer.request('host.status', {}));
    expect(writersSettled).toBe(false);
    expect(f.disposeUi).not.toHaveBeenCalled();
    expect(f.lifecycle).toEqual(['handler-start']);
    release.resolve();
    expect(await response).toMatchObject({ outcome: 'indeterminate', error: { code: 'indeterminate' } });
    await Promise.all([writers, closing]);
    expect(f.lifecycle).toEqual(['handler-start', 'handler-end', 'ui-settle', 'ui-dispose']);
    expect(f.disposeUi).toHaveBeenCalledOnce();
    expect(f.store.session(f.root.sessionId).state).toBe('closed');
    expect(f.updates).toContainEqual({ id: wireDocumentId(f.updates), remove: true });
  });
});
