import { uuidv7, type ExtensionUi, type UiElementHandle, type UiPresentOptions } from '@felan-ai/agent-core';
import type { UiDocument } from '@felan-ai/session-protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { OrderedAdmission } from '../src/daemon/admission.js';
import { createRegistryInteractionBroker } from '../src/daemon/broker.js';
import { HostLifecycle } from '../src/daemon/lifecycle.js';
import { settleDaemonWork } from '../src/daemon/service.js';
import { createUiVocabulary } from '../src/daemon/ui-vocabulary.js';
import { gate, serverFixture } from './fixtures/server.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const names = ['synthetic'] as const;
const document = (revision = 1): UiDocument => ({
  id: 'report', kind: 'document', revision, title: 'Report', markdown: 'Report', fallback: 'Report',
  actions: [{ id: 'close', label: 'Close', target: 'element', outcome: 'cancel' }],
});

async function fixture(delayPublication = false, onStream?: () => Promise<void>, cancelBehavior?: 'throws' | 'never resolves') {
  let ui!: ExtensionUi;
  const publish = gate();
  const f = await serverFixture({ now: Date.now, ...(onStream ? { onStream } : {}), extension: pi => {
    const lifetime = new AbortController();
    pi.on('session_shutdown', () => { lifetime.abort(); });
    for (const name of names) pi.registerCommand(name, { description: name, handler: async () => {
      if (delayPublication) await publish.promise;
      const closed = gate();
      let handle: UiElementHandle | undefined;
      lifetime.signal.addEventListener('abort', closed.resolve, { once: true });
      try {
        const opening = ui.present({ id: name, kind: 'document', revision: 1, title: name, markdown: name, fallback: name,
          actions: [{ id: 'close', label: 'Close', target: 'element', outcome: 'cancel' }] }, {
          signal: lifetime.signal,
          onAction: async () => {
            if (cancelBehavior === 'throws') throw new Error('private command cancellation failure');
            if (cancelBehavior === 'never resolves') await new Promise<void>(() => {});
            await opening; await handle!.close(); closed.resolve();
          },
        });
        handle = await opening;
        await closed.promise;
      } finally { lifetime.signal.removeEventListener('abort', closed.resolve); }
    } });
  } });
  const vocabulary = createUiVocabulary({ canRequest: () => false, request: async () => ({ state: 'cancelled', reason: 'unsupported' }),
    publish: update => f.registry.projection(f.root.sessionId).setPresentation(update),
  });
  ui = vocabulary.createExtensionUi('view-fixture');
  const release = f.registry.registerUiActions(f.root.sessionId, vocabulary.prepareAction);
  f.registry.registerService(f.root.sessionId, { busy: () => false, settle: async () => {},
    dispose: async () => { await vocabulary.dispose(); release(); },
  });
  cleanups.push(async () => { publish.resolve(); await f.dispose(); });
  const start = (name: typeof names[number]) => {
    const id = uuidv7();
    f.store.admit({ v: 1, id, op: 'command.invoke', session: f.root.sessionId, params: { name, arguments: '' } }, 'client');
    return f.registry.runAdmitted(id, f.root.sessionId, { kind: 'tui', attachment: 'client' }, session => session.prompt(`/${name}`));
  };
  const document = () => f.registry.projection(f.root.sessionId).snapshot().presentation.find(element => element.kind === 'document') as UiDocument | undefined;
  return { ...f, start, document, publish, ui, unbind: release };
}

async function requestStop(f: Awaited<ReturnType<typeof fixture>>, mode: 'drain' | 'force') {
  const broker = createRegistryInteractionBroker(f.registry);
  const complete = vi.fn(async () => {
    expect(f.registry.binding(f.root.sessionId)).toBeUndefined();
    await expect(f.registry.settleWriters()).resolves.toBeUndefined();
    expect(() => f.owner.assertCurrent()).not.toThrow();
  });
  const lifecycle = new HostLifecycle({ target: f.owner.target, identity: f.owner.identity, timeoutMs: 2000,
    beginDrain: () => f.registry.beginDrain(), complete,
    settle: mode => settleDaemonWork(f.registry, broker, mode),
  });
  const admission = new OrderedAdmission(f.store, { now: Date.now }); const id = uuidv7();
  const response = await admission.submit({ v: 1, id, op: 'host.stop', params: { expected: f.owner.identity, confirmed: true, mode } }, 'client', command => lifecycle.prepare(command));
  expect(response.outcome).toBe('accepted'); lifecycle.afterResponse(id);
  return { lifecycle, complete };
}

it.each(names)('%s awaits UI without model work, closes to idle, and reopens unchanged content', async name => {
  const f = await fixture();
  let previousId: string | undefined;
  for (let index = 0; index < 2; index++) {
    const work = f.start(name);
    await vi.waitFor(() => expect(f.document()).toBeDefined());
    const element = f.document()!;
    expect(element.id).not.toBe(previousId); previousId = element.id;
    expect(f.store.session(f.root.sessionId).run.state).toBe('waiting');
    const id = uuidv7();
    const action = { elementId: element.id, revision: element.revision, actionId: 'close', outcome: 'cancel' as const, values: {} };
    f.store.admit({ v: 1, id, op: 'ui.action', session: f.root.sessionId, params: action }, 'client');
    await f.registry.mutateAdmitted(id, f.root.sessionId, async () => {
      await f.registry.prepareUiAction(f.root.sessionId, action)({ requestId: id, signal: new AbortController().signal });
    });
    await work;
    expect(f.store.session(f.root.sessionId).run.state).toBe('idle');
    expect(f.document()).toBeUndefined();
  }
});

it.each(names)('cancel settles an awaited %s command without disposing its session', async name => {
  const f = await fixture(); const work = f.start(name);
  await vi.waitFor(() => expect(f.document()).toBeDefined());
  await f.registry.cancel(f.root.sessionId); await work;
  expect(f.store.session(f.root.sessionId)).toMatchObject({ state: 'open', run: { state: 'idle' } });
  expect(f.document()).toBeUndefined();
});

it.each(['drain', 'force'] as const)('%s stop closes awaited views before joining their command writers', async mode => {
  const f = await fixture(); const work = f.start('synthetic');
  await vi.waitFor(() => expect(f.document()).toBeDefined());
  const { lifecycle, complete } = await requestStop(f, mode);
  await work;
  await vi.waitFor(() => expect(lifecycle.state).toBe('stopped'));
  expect(complete).toHaveBeenCalledOnce();
});

it.each(['drain', 'force'] as const)('%s also cancels a view published after shutdown starts', async mode => {
  const f = await fixture(true); const work = f.start('synthetic');
  f.registry.beginDrain();
  const stopped = settleDaemonWork(f.registry, createRegistryInteractionBroker(f.registry), mode);
  f.publish.resolve();
  await stopped; await work;
  expect(f.registry.binding(f.root.sessionId)).toBeUndefined();
});

it.each(['throws', 'throws null', 'never resolves', 'invalid action', 'unbound'] as const)('force stop reaches stopped when a view cancel handler %s', async behavior => {
  const f = await fixture();
  const diagnostics = vi.fn(); f.registry.options.onViewCancellationDiagnostic = diagnostics;
  const abort = vi.spyOn(f.root.runtime.session, 'abort');
  const hostShutdown = vi.spyOn(f.registry.executionHost(f.root.sessionId), 'shutdown');
  let signal: AbortSignal | undefined;
  const handler = vi.fn<NonNullable<UiPresentOptions['onAction']>>(async (_action, context) => {
    expect(abort).toHaveBeenCalled(); expect(hostShutdown).toHaveBeenCalled();
    signal = context.signal;
    if (behavior === 'never resolves') await new Promise<void>(() => {});
    if (behavior === 'throws null') throw null;
    if (behavior === 'invalid action') throw Object.assign(new Error('Invalid action'), { code: 'invalid_request' });
    throw new Error('private handler failure');
  });
  await f.ui.present(document(), { onAction: handler });
  if (behavior === 'unbound') f.unbind();
  const { lifecycle, complete } = await requestStop(f, 'force');
  await vi.waitFor(() => expect(lifecycle.state).toBe('stopped'), { timeout: 1500 });
  expect(complete).toHaveBeenCalledOnce();
  expect(diagnostics).toHaveBeenCalledWith({ session: f.root.sessionId, elementId: expect.any(String), reason: behavior === 'never resolves' ? 'timeout' : 'failed' });
  expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('private handler failure');
  if (signal) expect(signal.aborted).toBe(true);
});

it.each(['throws', 'never resolves'] as const)('force stop settles a command writer when its view cancel handler %s', async behavior => {
  const f = await fixture(false, undefined, behavior);
  const diagnostics = vi.fn(); f.registry.options.onViewCancellationDiagnostic = diagnostics;
  let settled = false;
  const work = f.start('synthetic').then(() => { settled = true; });
  await vi.waitFor(() => expect(f.document()).toBeDefined());
  await f.root.runtime.session.abort();
  expect(f.root.runtime.session.isIdle).toBe(true);
  expect(settled).toBe(false);
  expect(f.store.session(f.root.sessionId).run.state).toBe('waiting');
  const dispose = f.root.runtime.dispose.bind(f.root.runtime);
  const disposing = vi.spyOn(f.root.runtime, 'dispose').mockImplementation(async () => {
    expect(f.registry.binding(f.root.sessionId)).toBe(f.root);
    expect(() => f.owner.assertCurrent()).not.toThrow();
    await dispose();
  });
  const { lifecycle, complete } = await requestStop(f, 'force');
  await vi.waitFor(() => expect(lifecycle.state).toBe('stopped'), { timeout: 1500 });
  await work;
  expect(settled).toBe(true);
  expect(complete).toHaveBeenCalledOnce();
  expect(disposing).toHaveBeenCalledOnce();
  expect(diagnostics).toHaveBeenCalledWith({ session: f.root.sessionId, elementId: expect.any(String), reason: behavior === 'never resolves' ? 'timeout' : 'failed' });
});

it('force stop releases a command writer and a session cancel already waiting on it', async () => {
  const f = await fixture(false, undefined, 'throws');
  const work = f.start('synthetic');
  await vi.waitFor(() => expect(f.document()).toBeDefined());
  const cancelling = f.registry.cancel(f.root.sessionId);
  await vi.waitFor(() => expect(f.store.session(f.root.sessionId).run.state).toBe('cancelling'));
  const { lifecycle, complete } = await requestStop(f, 'force');
  await vi.waitFor(() => expect(lifecycle.state).toBe('stopped'), { timeout: 1500 });
  await work; await cancelling;
  expect(complete).toHaveBeenCalledOnce();
});

it('retains ownership after runtime disposal until the interrupted command writer settles', async () => {
  const f = await fixture(false, undefined, 'throws');
  const returning = gate(); const release = gate();
  cleanups.push(async () => { release.resolve(); });
  const prompt = f.root.runtime.session.prompt.bind(f.root.runtime.session);
  vi.spyOn(f.root.runtime.session, 'prompt').mockImplementation(async (...args) => {
    await prompt(...args); returning.resolve(); await release.promise;
  });
  const work = f.start('synthetic');
  await vi.waitFor(() => expect(f.document()).toBeDefined());
  const { lifecycle, complete } = await requestStop(f, 'force');
  await returning.promise;
  expect(lifecycle.state).toBe('draining');
  expect(complete).not.toHaveBeenCalled();
  expect(f.registry.binding(f.root.sessionId)).toBe(f.root);
  expect(() => f.owner.assertCurrent()).not.toThrow();
  release.resolve(); await work;
  await vi.waitFor(() => expect(lifecycle.state).toBe('stopped'));
  expect(complete).toHaveBeenCalledOnce();
});

it('does not release ownership when early runtime disposal fails', async () => {
  const f = await fixture(false, undefined, 'throws');
  const work = f.start('synthetic');
  await vi.waitFor(() => expect(f.document()).toBeDefined());
  const dispose = vi.spyOn(f.root.runtime, 'dispose').mockRejectedValue(new Error('Cleanup failed'));
  const { lifecycle, complete } = await requestStop(f, 'force');
  await vi.waitFor(() => expect(lifecycle.state).toBe('blocked'));
  expect(complete).not.toHaveBeenCalled();
  expect(f.registry.binding(f.root.sessionId)).toBe(f.root);
  expect(() => f.owner.assertCurrent()).not.toThrow();
  dispose.mockRestore();
  await f.registry.shutdown({ interrupt: true }); await work;
});

it('starts host shutdown while view cancellation is queued behind an active action', async () => {
  const f = await fixture(); const entered = gate(); const release = gate();
  cleanups.push(async () => { release.resolve(); });
  const handler = vi.fn<NonNullable<UiPresentOptions['onAction']>>(async action => {
    if (action.actionId === 'edit') { entered.resolve(); await release.promise; }
    else await handle.close();
  });
  const handle = await f.ui.present({ ...document(), actions: [
    { id: 'edit', label: 'Edit', target: 'element', outcome: 'submit' }, ...document().actions,
  ] }, { onAction: handler });
  const element = f.document()!;
  const editing = f.registry.prepareUiAction(f.root.sessionId, {
    elementId: element.id, revision: element.revision, actionId: 'edit', outcome: 'submit', values: {},
  })({ requestId: uuidv7(), signal: new AbortController().signal });
  await entered.promise;
  const host = f.registry.executionHost(f.root.sessionId); const shutdown = host.shutdown.bind(host);
  vi.spyOn(host, 'shutdown').mockImplementation(async () => { release.resolve(); await shutdown(); });
  const { lifecycle } = await requestStop(f, 'force');
  await editing;
  await vi.waitFor(() => expect(lifecycle.state).toBe('stopped'));
  expect(handler).toHaveBeenCalledTimes(2);
});

it('does not let a diagnostic failure block force stop', async () => {
  const f = await fixture();
  f.registry.options.onViewCancellationDiagnostic = () => { throw new Error('Diagnostic failed'); };
  await f.ui.present(document(), { onAction: async () => { throw new Error('Cancel failed'); } });
  const { lifecycle } = await requestStop(f, 'force');
  await vi.waitFor(() => expect(lifecycle.state).toBe('stopped'));
});

it('force stops after a client cancel action has already hung', async () => {
  const f = await fixture(); const entered = gate();
  await f.ui.present(document(), { onAction: async () => { entered.resolve(); await new Promise<void>(() => {}); } });
  const element = f.document()!; const id = uuidv7();
  const action = { elementId: element.id, revision: element.revision, actionId: 'close', outcome: 'cancel' as const, values: {} };
  f.store.admit({ v: 1, id, op: 'ui.action', session: f.root.sessionId, params: action }, 'client');
  const cancelling = f.registry.mutateAdmitted(id, f.root.sessionId, async () => {
    await f.registry.prepareUiAction(f.root.sessionId, action)({ requestId: id, signal: new AbortController().signal });
  }).then(() => undefined, error => error);
  await entered.promise;
  const { lifecycle } = await requestStop(f, 'force');
  expect(await cancelling).toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(lifecycle.state).toBe('stopped'));
});

it('caps re-publications across late cancellation requests without fencing the registry', async () => {
  const f = await fixture(); let revision = 1;
  const diagnostics = vi.fn(); f.registry.options.onViewCancellationDiagnostic = diagnostics;
  const handler = vi.fn(async () => { await handle.update(document(++revision)); });
  const handle = await f.ui.present(document(), { onAction: handler });
  const { lifecycle } = await requestStop(f, 'force');
  await vi.waitFor(() => expect(lifecycle.state).toBe('stopped'));
  expect(handler).toHaveBeenCalledTimes(8);
  expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ reason: 'limit' }));
  await expect(f.registry.settleWriters()).resolves.toBeUndefined();
});

it('does not fence the registry when a late view cancellation fails', async () => {
  const f = await fixture();
  const diagnostics = vi.fn(); f.registry.options.onViewCancellationDiagnostic = diagnostics;
  f.registry.beginDrain();
  await f.ui.present(document(), { onAction: async () => { throw new Error('Cancel failed'); } });
  await vi.waitFor(() => expect(diagnostics).toHaveBeenCalledOnce());
  expect(() => f.registry.assertAdmission()).not.toThrow();
  await settleDaemonWork(f.registry, createRegistryInteractionBroker(f.registry), 'force');
  await expect(f.registry.settleWriters()).resolves.toBeUndefined();
});

it('cancels a publication queued by the last empty view scan', async () => {
  const f = await fixture(); const projection = f.registry.projection(f.root.sessionId);
  const presentations = projection.presentations.bind(projection);
  let publication: Promise<void> | undefined;
  const closed = gate();
  vi.spyOn(projection, 'presentations').mockImplementationOnce(() => {
    publication = Promise.resolve().then(async () => {
      const handle = await f.ui.present(document(), { onAction: async () => { await handle.close(); closed.resolve(); } });
    });
    return presentations();
  });
  f.registry.beginDrain();
  await f.registry.waitForDrain();
  await publication; await closed.promise;
  expect(f.document()).toBeUndefined();
  await settleDaemonWork(f.registry, createRegistryInteractionBroker(f.registry), 'drain');
});

it.each([false, true])('preserves the run identity for a turn during view waiting (close during turn: %s)', async closeDuringTurn => {
  const streaming = gate(); const started = gate();
  const f = await fixture(false, async () => { started.resolve(); await streaming.promise; });
  cleanups.push(async () => { streaming.resolve(); });
  const command = f.start('synthetic');
  await vi.waitFor(() => expect(f.document()).toBeDefined());
  const runId = f.store.session(f.root.sessionId).run.id;
  expect(f.store.session(f.root.sessionId).run.state).toBe('waiting');
  const turn = f.root.runtime.session.prompt('background completion');
  await started.promise;
  expect(f.store.session(f.root.sessionId).run).toMatchObject({ id: runId, state: 'running' });
  const close = async () => {
    const element = f.document()!;
    await f.registry.prepareUiAction(f.root.sessionId, { elementId: element.id, revision: element.revision, actionId: 'close', outcome: 'cancel', values: {} })({ requestId: uuidv7(), signal: new AbortController().signal });
    await command;
  };
  if (closeDuringTurn) await close();
  streaming.resolve(); await turn;
  if (!closeDuringTurn) {
    await vi.waitFor(() => expect(f.store.session(f.root.sessionId).run).toMatchObject({ id: runId, state: 'waiting' }));
    await close();
  }
  await vi.waitFor(() => expect(f.store.session(f.root.sessionId).run).toMatchObject({ id: runId, state: 'idle' }));
});
