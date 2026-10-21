import { afterEach, expect, it, vi } from 'vitest';
import { uuidv7 } from '@felan-ai/agent-core';
import { parseClientEnvelope, type ClientEnvelope } from '@felan-ai/session-protocol';
import { SessionServer } from '../src/daemon/server.js';
import { OrderedAdmission } from '../src/daemon/admission.js';
import { SessionCommands } from '../src/daemon/commands.js';
import type { SessionRuntime } from '../src/daemon/session-runtime.js';
import { TestHostConfiguration } from './fixtures/host-services.js';
import { gate, serverFixture } from './fixtures/server.js';
import { createTestSessionRuntime } from './fixtures/session-runtime.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const hold = gate();
  let active = false;
  const queue: Array<() => void> = [];
  const release = vi.fn(() => { const next = queue.shift(); if (next) next(); else active = false; });
  const acquireRun = vi.fn<NonNullable<SessionRuntime['acquireRun']>>(async (_session, signal) => {
    if (active) await new Promise<void>((resolve, reject) => {
      const grant = () => { signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => { queue.splice(queue.indexOf(grant), 1); reject(signal.reason); };
      queue.push(grant);
      signal.addEventListener('abort', abort, { once: true });
    });
    active = true;
    return release;
  });
  const f = await serverFixture({ onStream: () => hold.promise,
    extension: pi => pi.registerCommand('run-test', { description: 'Test command', handler: async () => {} }),
    createComposition: runtimeFactory => ({ ...createTestSessionRuntime({ runtimeFactory }), acquireRun }),
  });
  const second = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, model: f.root.runtime.session.model! });
  const prompt = vi.spyOn(second.runtime.session, 'prompt');
  const commandOptions = { registry: f.registry,
    configuration: new TestHostConfiguration({ definitions: [], assertCurrent: () => f.registry.assertAdmission() }),
    models: f.root.runtime.session.modelRuntime, invalidated() {},
  };
  const commands = new SessionCommands(commandOptions); const admission = new OrderedAdmission(f.store);
  const server = new SessionServer({ ...commandOptions, version: 'test' });
  cleanups.push(async () => { hold.resolve(); server.close(); await f.dispose(); });
  const submit = (op: ClientEnvelope['op'], session: string, params: unknown) => {
    const command = uuidv7();
    const request = parseClientEnvelope({ v: 1, id: command, op, session, params });
    if (op === 'command.invoke') return admission.submit(request, 'test', admitted => commands.prepare(admitted, { origin: { kind: 'headless', attachment: 'test' } }));
    return server.submitRemote(request, { command, automation: { source: 'test' } });
  };
  return { ...f, second, prompt, submit, hold, acquireRun, release };
}

it.each(['prompt', 'follow_up', 'command.invoke'] as const)('accepts a root %s while queued, then executes after the first root settles', async op => {
  const f = await fixture();
  expect(await f.submit('prompt', f.root.sessionId, { text: 'First' })).toMatchObject({ outcome: 'accepted' });
  await vi.waitFor(() => expect(f.root.runtime.session.isIdle).toBe(false));
  const params = op === 'command.invoke' ? { name: 'run-test', arguments: '' } : { text: 'Second' };
  expect(await f.submit(op, f.second.sessionId, params)).toMatchObject({ outcome: 'accepted' });
  expect(f.store.session(f.second.sessionId).run.state).toBe('running');
  expect(f.acquireRun).toHaveBeenCalledTimes(2);
  expect(f.prompt).not.toHaveBeenCalled();
  f.hold.resolve();
  await vi.waitFor(() => expect(f.prompt).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledTimes(2));
  expect(f.store.session(f.second.sessionId).run.state).toBe('idle');
});

it('aborts a queued root without executing and without leaking the permit', async () => {
  const f = await fixture();
  await f.submit('prompt', f.root.sessionId, { text: 'First' });
  await f.submit('prompt', f.second.sessionId, { text: 'Cancelled' });
  const signal = f.acquireRun.mock.calls[1]![1];
  const runId = f.store.session(f.second.sessionId).run.id!;
  expect(await f.submit('command.invoke', f.second.sessionId, { name: 'run-test', arguments: '' }))
    .toMatchObject({ outcome: 'rejected', error: { code: 'busy' } });
  expect(await f.submit('cancel', f.second.sessionId, { runId })).toMatchObject({ outcome: 'accepted' });
  expect(signal.aborted).toBe(true);
  expect(f.prompt).not.toHaveBeenCalled();
  expect(f.store.session(f.second.sessionId).run.state).toBe('idle');
  expect(f.registry.projection(f.second.sessionId).snapshot().presentation).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'run-error' })]));
  f.hold.resolve();
  await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce());
  expect(await f.submit('prompt', f.second.sessionId, { text: 'Retry' })).toMatchObject({ outcome: 'accepted' });
  await vi.waitFor(() => expect(f.prompt).toHaveBeenCalledOnce());
});

it('does not acquire root permits for children', async () => {
  const f = await fixture();
  await f.submit('prompt', f.root.sessionId, { text: 'First' });
  const child = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, model: f.root.runtime.session.model!,
    parentSessionId: f.root.sessionId, rootSessionId: f.root.sessionId });
  expect(await f.submit('prompt', child.sessionId, { text: 'Child' })).toMatchObject({ outcome: 'accepted' });
  await vi.waitFor(() => expect(child.runtime.session.isIdle).toBe(false));
  expect(f.acquireRun).toHaveBeenCalledOnce();
});

it.each(['close', 'shutdown'] as const)('aborts queued acquisition on %s', async action => {
  const f = await fixture();
  await f.submit('prompt', f.root.sessionId, { text: 'First' });
  await f.submit('prompt', f.second.sessionId, { text: 'Never run' });
  if (action === 'close') await f.registry.close(f.second.sessionId);
  else { f.hold.resolve(); await f.registry.shutdown({ interrupt: true }); }
  expect(f.acquireRun.mock.calls[1]![1].aborted).toBe(true);
  expect(f.prompt).not.toHaveBeenCalled();
});

it.each([false, true])('gates deferred-interaction continuations (cancel=%s)', async cancel => {
  const f = await fixture();
  await f.submit('prompt', f.root.sessionId, { text: 'First' });
  const interaction = uuidv7(); const continuation = uuidv7(); const answerRequest = uuidv7();
  const answer = { kind: 'confirm' as const, confirmed: true };
  f.store.putInteraction({ id: interaction, state: 'waiting', deferrable: true, createdAt: f.store.snapshot().clock,
    scope: { kind: 'session', session: f.second.sessionId, root: f.second.sessionId },
    request: { kind: 'confirm', title: 'Continue', message: 'Continue?' } });
  f.store.deferInteraction(interaction);
  f.store.admit(parseClientEnvelope({ v: 1, id: answerRequest, op: 'interaction.answer', session: f.second.sessionId,
    params: { interactionId: interaction, answer } }), 'test');
  f.store.answerInteraction(answerRequest, answer, continuation);
  const work = f.registry.resumeInteraction(f.second.sessionId, answer, continuation,
    () => { f.store.transitionContinuation(continuation, 'dispatch_intent'); });
  await vi.waitFor(() => expect(f.acquireRun).toHaveBeenCalledTimes(2));
  expect(f.prompt).not.toHaveBeenCalled();
  if (cancel) {
    await f.registry.cancel(f.second.sessionId, continuation);
    await work;
    expect(f.prompt).not.toHaveBeenCalled();
  } else {
    f.hold.resolve(); await work;
    expect(f.prompt).toHaveBeenCalledOnce();
  }
});
