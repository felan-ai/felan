import { afterEach, expect, it, vi } from 'vitest';
import { JsonLineDecoder, encodeFrame, type ClientEnvelope, type OperationParams } from '@felan-ai/session-protocol';
import { createRegistryInteractionBroker } from '../src/daemon/broker.js';
import { SessionFanout } from '../src/daemon/fanout.js';
import { connectLocalIpc } from '../src/daemon/ipc.js';
import { HostLifecycle } from '../src/daemon/lifecycle.js';
import { SessionServer, type BrokerDispatchPort } from '../src/daemon/server.js';
import { protocolTarget } from '../src/daemon/target.js';
import { TestHostConfiguration } from './fixtures/host-services.js';
import { gate, requestId, serverFixture } from './fixtures/server.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(management = false) {
  const f = await serverFixture({ now: Date.now });
  const broker = createRegistryInteractionBroker(f.registry);
  const port: BrokerDispatchPort = broker;
  const stopped = gate();
  const settle = vi.fn(async () => {});
  const lifecycle = new HostLifecycle({ target: f.owner.target, identity: f.owner.identity,
    beginDrain() {}, endDrain() {}, settle, complete: async () => { stopped.resolve(); } });
  const server = new SessionServer({ registry: f.registry, broker, version: 'fixture',
    configuration: new TestHostConfiguration({ definitions: [], assertCurrent: () => f.registry.assertAdmission() }),
    ...(management ? { management: { lifecycle, logs: () => { throw new Error('Unexpected logs request'); } } } : {}),
    models: f.root.runtime.session.modelRuntime });
  cleanups.push(async () => { server.close(); await broker.drain(); await f.dispose(); });
  await server.start();
  async function client(kinds: OperationParams<'hello'>['interactionKinds'] = ['confirm']) {
    const socket = await connectLocalIpc(f.owner.target);
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
    cleanups.push(async () => { socket.destroy(); });
    const decoder = new JsonLineDecoder();
    const pending = new Map<string, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
    const events: Record<string, unknown>[] = [];
    socket.on('data', (bytes: Buffer) => {
      for (const frame of decoder.push(bytes)) {
        const value = frame as Record<string, unknown>; const waiter = pending.get(String(value.re));
        if (waiter) { pending.delete(String(value.re)); waiter.resolve(value); }
        else events.push(value);
      }
    });
    socket.on('close', () => { for (const waiter of pending.values()) waiter.reject(new Error('Connection closed before response')); pending.clear(); });
    const exchange = <T extends { id: string }>(request: T) => new Promise<Record<string, unknown>>((resolve, reject) => {
      pending.set(request.id, { resolve, reject }); socket.write(encodeFrame(request));
    });
    const hello = await exchange({ v: 1, id: requestId(), op: 'hello', params: { clientVersion: 'fixture', protocol: 1, kind: 'tui',
      interactionKinds: kinds, capabilities: ['ui.action'], target: protocolTarget(f.owner.target) } });
    const attachment = (hello.result as { attachmentId: string }).attachmentId;
    expect(await exchange({ v: 1, id: requestId(), op: 'attach', session: f.root.sessionId, params: { expected: f.owner.identity } })).toMatchObject({ outcome: 'accepted' });
    return { socket, closed, exchange, attachment, events };
  }
  return { ...f, broker, port, server, client, settle, stopped };
}

function fillTerminalResources(f: Awaited<ReturnType<typeof fixture>>) {
  const session = f.root.sessionId;
  for (let index = 0; index < 1001; index++) f.store.putResource({ id: `finished-${index}`, session, root: session,
    kind: 'detached', state: 'exited', updatedAt: 0 });
}

function confirmation(f: Awaited<ReturnType<typeof fixture>>) {
  const session = f.root.sessionId;
  const outcome = f.broker.request({ kind: 'confirm', title: 'Git Push', message: 'Synthetic confirmation; no command is executed.' },
    { kind: 'session', session, root: session });
  const interaction = f.broker.pending().at(-1)!;
  const request: Extract<ClientEnvelope, { op: 'interaction.answer' }> = { v: 1, id: requestId(), op: 'interaction.answer', session,
    params: { interactionId: interaction.id, answer: { kind: 'confirm', confirmed: true } } };
  return { outcome, interaction, request };
}

it.each([true, false])('resynchronizes before admitting an action that awaits nested confirm=%s', async confirmed => {
  const f = await fixture(); const session = f.root.sessionId;
  const client = await f.client(); fillTerminalResources(f);
  const handler = vi.fn(async () => {
    const result = await f.broker.request({ kind: 'confirm', title: 'Nested action', message: 'Continue?' },
      { kind: 'session', session, root: session });
    expect(result).toEqual({ state: 'answered', answer: { kind: 'confirm', confirmed } });
  });
  const unregister = f.registry.registerUiActions(session, () => handler);
  cleanups.push(async () => unregister());
  const request: ClientEnvelope = { v: 1, id: requestId(), op: 'ui.action', session,
    params: { elementId: 'nested', revision: 1, actionId: 'submit', outcome: 'submit', values: {} } };
  const attempted = gate(); const admit = f.store.admit.bind(f.store);
  vi.spyOn(f.store, 'admit').mockImplementation((...args) => {
    try { return admit(...args); } finally { attempted.resolve(); }
  });
  const first = client.exchange(request).catch(error => error as Error);
  await attempted.promise;
  expect(f.store.request(request.id)).toBeUndefined();
  expect(handler).not.toHaveBeenCalled();
  await client.closed; await first;
  const retry = await f.client();
  const response = retry.exchange(request);
  await vi.waitFor(() => expect(f.broker.pending()).toHaveLength(1));
  const interaction = f.broker.pending()[0]!;
  await vi.waitFor(() => expect(retry.events).toContainEqual(expect.objectContaining({ change: expect.objectContaining({ type: 'interaction.requested' }) })));
  expect(await retry.exchange({ v: 1, id: requestId(), op: 'interaction.answer', session,
    params: { interactionId: interaction.id, answer: { kind: 'confirm', confirmed } } })).toMatchObject({ outcome: 'accepted' });
  expect(await response).toMatchObject({ outcome: 'accepted' });
  expect(await retry.exchange(request)).toMatchObject({ outcome: 'accepted' });
  expect(handler).toHaveBeenCalledOnce();
});

it('does not hold maintenance resync behind an in-flight action awaiting a nested interaction', async () => {
  const f = await fixture(); const session = f.root.sessionId; const client = await f.client();
  const entered = gate(); const proceed = gate();
  cleanups.push(async () => proceed.resolve());
  const handler = vi.fn(async () => {
    entered.resolve(); await proceed.promise;
    await f.broker.request({ kind: 'confirm', title: 'Nested action', message: 'Continue?' }, { kind: 'session', session, root: session });
  });
  const unregister = f.registry.registerUiActions(session, () => handler);
  cleanups.push(async () => unregister());
  const action: ClientEnvelope = { v: 1, id: requestId(), op: 'ui.action', session,
    params: { elementId: 'nested', revision: 1, actionId: 'submit', outcome: 'submit', values: {} } };
  const first = client.exchange(action).catch(error => error as Error);
  await entered.promise; fillTerminalResources(f);
  const attempted = gate(); const admit = f.store.admit.bind(f.store);
  vi.spyOn(f.store, 'admit').mockImplementation((...args) => {
    try { return admit(...args); } finally { attempted.resolve(); }
  });
  const rename: ClientEnvelope = { v: 1, id: requestId(), op: 'session.rename', session, params: { name: 'Still responsive' } };
  const renaming = client.exchange(rename).catch(error => error as Error);
  await attempted.promise; proceed.resolve();
  await vi.waitFor(() => expect(f.broker.pending()).toHaveLength(1));
  const interaction = f.broker.pending()[0]!;
  expect(f.broker.canReceive(client.attachment, interaction)).toBe(false);
  expect(f.store.request(rename.id)).toBeUndefined();
  await client.closed; await Promise.all([first, renaming]);
  const retry = await f.client();
  expect(await retry.exchange({ v: 1, id: requestId(), op: 'interaction.answer', session,
    params: { interactionId: interaction.id, answer: { kind: 'confirm', confirmed: true } } })).toMatchObject({ outcome: 'accepted' });
  expect(await retry.exchange(action)).toMatchObject({ outcome: 'accepted' });
  expect(await retry.exchange(rename)).toMatchObject({ outcome: 'accepted' });
  expect(handler).toHaveBeenCalledOnce();
});

it.each([true, false])('retries explicit confirm=%s with an unpersisted ID after pruning resync', async confirmed => {
  const f = await fixture(); const session = f.root.sessionId;
  fillTerminalResources(f);
  const observer = await f.client(); const answerer = await f.client();
  const { outcome, interaction, request } = confirmation(f);
  request.params.answer = { kind: 'confirm', confirmed };
  const dispatch = vi.spyOn(f.broker, 'dispatch');
  const originalDisconnected = f.broker.disconnected.bind(f.broker);
  vi.spyOn(f.broker, 'disconnected').mockImplementation(attachment => {
    if (attachment === observer.attachment) f.registry.publishCommitted(f.store.updateSession(session, { title: 'Observer disconnected' }).revisions);
    originalDisconnected(attachment);
  });
  await expect(answerer.exchange(request)).rejects.toThrow('Connection closed before response');
  await Promise.all([observer.closed, answerer.closed]);
  expect(f.store.request(request.id)).toBeUndefined();
  expect(f.broker.pending()).toEqual([interaction]); expect(dispatch).not.toHaveBeenCalled();
  const retry = await f.client(); const response = await retry.exchange(request);
  expect(response).toEqual({ v: 1, re: request.id, outcome: 'accepted', result: {} });
  await expect(outcome).resolves.toEqual({ state: 'answered', answer: { kind: 'confirm', confirmed } });
  expect(f.store.resources(session)).toHaveLength(1000);
  expect(f.store.request(request.id)).toMatchObject({ phase: 'terminal', response });
  expect(await retry.exchange(request)).toEqual(response); expect(dispatch).toHaveBeenCalledOnce();
});

it('does not wait for an unrelated response write callback before maintenance resync', async () => {
  const f = await fixture(); const client = await f.client(); const first = confirmation(f);
  let release: (() => void) | undefined;
  const send = SessionFanout.prototype.send;
  vi.spyOn(SessionFanout.prototype, 'send').mockImplementation(function (this: SessionFanout, value, afterSend) {
    return send.call(this, value, value && typeof value === 'object' && 're' in value && value.re === first.request.id
      ? () => { release = afterSend; } : afterSend);
  });
  expect(await client.exchange(first.request)).toMatchObject({ outcome: 'accepted' });
  await expect(first.outcome).resolves.toMatchObject({ state: 'answered' });
  expect(release).toBeTypeOf('function');
  const second = confirmation(f); fillTerminalResources(f);
  await expect(client.exchange(second.request)).rejects.toThrow('Connection closed before response');
  await client.closed;
  expect(f.broker.canReceive(client.attachment, second.interaction)).toBe(false);
  expect(f.store.request(second.request.id)).toBeUndefined();
  release!();
  const retry = await f.client();
  expect(await retry.exchange(first.request)).toMatchObject({ outcome: 'accepted' });
  expect(await retry.exchange(second.request)).toMatchObject({ outcome: 'accepted' });
  await expect(second.outcome).resolves.toMatchObject({ state: 'answered' });
});

it('revokes an already-admitted delayed answer rather than holding maintenance behind it', async () => {
  const f = await fixture(); const client = await f.client();
  const first = confirmation(f); const second = confirmation(f);
  const entered = gate(); const proceed = gate();
  cleanups.push(async () => proceed.resolve());
  const dispatch = f.broker.dispatch.bind(f.broker);
  vi.spyOn(f.port, 'dispatch').mockImplementation(async (command, caller) => {
    if (command.request.id === first.request.id) { entered.resolve(); await proceed.promise; }
    return dispatch(command, caller);
  });
  const firstResponse = client.exchange(first.request).catch(error => error as Error);
  await entered.promise; fillTerminalResources(f);
  await expect(client.exchange(second.request)).rejects.toThrow('Connection closed before response');
  await client.closed;
  expect(f.broker.canReceive(client.attachment, second.interaction)).toBe(false);
  expect(f.store.request(second.request.id)).toBeUndefined();
  proceed.resolve(); await firstResponse; await f.server.settleCommands();
  expect(f.store.request(first.request.id)).toMatchObject({ phase: 'terminal', response: { outcome: 'rejected', error: { code: 'forbidden' } } });
  const retry = await f.client();
  expect(await retry.exchange(first.request)).toMatchObject({ outcome: 'rejected', error: { code: 'forbidden' } });
  expect(await retry.exchange(second.request)).toMatchObject({ outcome: 'accepted' });
  await expect(second.outcome).resolves.toMatchObject({ state: 'answered' });
});

it('joins concurrent duplicates after a pre-admission resync without dispatching an answer twice', async () => {
  const f = await fixture(); fillTerminalResources(f);
  const initial = await f.client(); const { request, outcome } = confirmation(f);
  await expect(initial.exchange(request)).rejects.toThrow('Connection closed before response');
  expect(f.store.request(request.id)).toBeUndefined();
  const client = await f.client(); const retry = await f.client();
  const entered = gate(); const proceed = gate(); const duplicated = gate();
  cleanups.push(async () => proceed.resolve());
  const dispatch = f.broker.dispatch.bind(f.broker);
  const calls = vi.spyOn(f.port, 'dispatch').mockImplementation(async (command, caller) => {
    entered.resolve(); await proceed.promise; return dispatch(command, caller);
  });
  const first = client.exchange(request); await entered.promise;
  const admit = f.store.admit.bind(f.store);
  vi.spyOn(f.store, 'admit').mockImplementation((...args) => {
    const result = admit(...args); duplicated.resolve(); return result;
  });
  const second = retry.exchange(request); await duplicated.promise; proceed.resolve();
  expect(await second).toEqual(await first);
  expect(calls).toHaveBeenCalledOnce();
  await expect(outcome).resolves.toMatchObject({ state: 'answered' });
});

it('still rejects an incapable client and leaves confirmation unanswered after pruning', async () => {
  const f = await fixture(); fillTerminalResources(f);
  const initial = await f.client([]); const { request, interaction } = confirmation(f);
  await expect(initial.exchange(request)).rejects.toThrow('Connection closed before response');
  expect(f.store.request(request.id)).toBeUndefined();
  const client = await f.client([]);
  expect(await client.exchange(request)).toMatchObject({ outcome: 'rejected', error: { code: 'forbidden' } });
  expect(f.broker.pending()).toEqual([interaction]);
  expect(f.store.request(request.id)).toMatchObject({ phase: 'terminal', response: { outcome: 'rejected', error: { code: 'forbidden' } } });
});

it('revokes a genuinely disconnected client before delayed dispatch and never retries its answer', async () => {
  const f = await fixture();
  const client = await f.client(); const { request, interaction } = confirmation(f);
  const entered = gate(); const proceed = gate(); const disconnected = gate();
  cleanups.push(async () => { proceed.resolve(); });
  const dispatch = f.broker.dispatch.bind(f.broker);
  const calls = vi.spyOn(f.port, 'dispatch').mockImplementation(async (command, caller) => {
    entered.resolve(); await proceed.promise; return dispatch(command, caller);
  });
  const disconnect = f.broker.disconnected.bind(f.broker);
  vi.spyOn(f.broker, 'disconnected').mockImplementation(attachment => { disconnect(attachment); disconnected.resolve(); });
  const response = client.exchange(request).catch(error => error as Error);
  await entered.promise; client.socket.destroy(); await disconnected.promise; proceed.resolve();
  await response; await f.server.settleCommands();
  expect(f.store.request(request.id)).toMatchObject({ phase: 'terminal', response: { outcome: 'rejected', error: { code: 'forbidden' } } });
  const retry = await f.client();
  expect(await retry.exchange(request)).toMatchObject({ outcome: 'rejected', error: { code: 'forbidden' } });
  expect(calls).toHaveBeenCalledOnce(); expect(f.broker.pending()).toEqual([interaction]);
});

it.each([undefined, 'local-console'] as const)('keeps remote answer authority unchanged during pruning: %s', async authority => {
  const f = await fixture(); fillTerminalResources(f);
  const client = await f.client(); const session = f.root.sessionId;
  const outcome = f.broker.request({ kind: 'confirm', title: 'Synthetic remote confirmation', message: '' },
    { kind: 'session', session, root: session }, authority ? { authority } : {});
  const interaction = f.broker.pending()[0]!;
  const request: ClientEnvelope = { v: 1, id: requestId(), op: 'interaction.answer', session,
    params: { interactionId: interaction.id, answer: { kind: 'confirm', confirmed: false } } };
  const remote = { user: 'remote-user', command: 'remote-command', interactionKinds: ['confirm'] as const };
  const response = await f.server.submitRemote(request, { ...remote, interactionKinds: [...remote.interactionKinds] });
  if (authority) {
    expect(response).toMatchObject({ outcome: 'rejected', error: { code: 'forbidden' } });
    expect(f.broker.pending()).toEqual([interaction]);
  } else {
    expect(response).toMatchObject({ outcome: 'accepted' });
    await expect(outcome).resolves.toEqual({ state: 'answered', answer: { kind: 'confirm', confirmed: false } });
  }
  expect(await f.server.submitRemote(request, { ...remote, interactionKinds: [...remote.interactionKinds] })).toEqual(response);
  await client.closed;
});

it.each(['control', 'command'])('resynchronizes an attached %s management request before admission and flushes the retry before shutdown', async kind => {
  const f = await fixture(true); fillTerminalResources(f);
  const initial = await f.client(); const id = requestId();
  const request = { ...(kind === 'control' ? { control: 1 } : { v: 1 }), id,
    op: 'host.stop', params: { expected: f.owner.identity, mode: 'drain' } };
  await expect(initial.exchange(request)).rejects.toThrow('Connection closed before response');
  expect(f.store.request(id)).toBeUndefined(); expect(f.settle).not.toHaveBeenCalled();
  const client = await f.client();
  let release: (() => void) | undefined;
  const send = SessionFanout.prototype.send;
  vi.spyOn(SessionFanout.prototype, 'send').mockImplementation(function (this: SessionFanout, value, afterSend) {
    return send.call(this, value, value && typeof value === 'object' && 're' in value && value.re === id
      ? () => { release = afterSend; } : afterSend);
  });
  const response = await client.exchange(request);
  expect(response).toMatchObject({ outcome: 'accepted' });
  expect(f.settle).not.toHaveBeenCalled(); expect(release).toBeTypeOf('function');
  release!(); await f.stopped.promise;
  expect(f.settle).toHaveBeenCalledOnce();
});
