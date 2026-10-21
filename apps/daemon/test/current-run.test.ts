import { uuidv7 } from '@felan-ai/agent-core';
import { parseClientEnvelope } from '@felan-ai/session-protocol';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionExtensionContext } from '../src/daemon/provider.js';
import { createRegistryInteractionBroker, type InteractionBroker } from '../src/daemon/broker.js';
import { createDaemonExecutionServices } from '../src/daemon/execution-services.js';
import { SessionServer } from '../src/daemon/server.js';
import type { SessionRuntime } from '../src/daemon/session-runtime.js';
import { TestHostConfiguration } from './fixtures/host-services.js';
import { gate, serverFixture } from './fixtures/server.js';
import { createTestSessionRuntime } from './fixtures/session-runtime.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const hold = gate(); const streamStarted = gate();
  const contexts = new Map<string, SessionExtensionContext>();
  const observations: Array<{ session: string; point: string; run: ReturnType<SessionExtensionContext['currentRun']> }> = [];
  const composition: SessionRuntime = {
    ...createTestSessionRuntime(),
    async bindExtensions(context) {
      const session = context.sessionManager.getSessionId();
      contexts.set(session, context);
      const observe = (point: string) => observations.push({ session, point, run: context.currentRun() });
      return {
        importExtension: context.importExtension,
        wrapStreamFunction: stream => (...args) => { observe('stream'); return stream(...args); },
        inlineExtensions: [{ name: 'current-run-observer', factory: pi => {
          pi.on('message_end', event => { observe(event.message.role); });
        } }],
        async dispose() {},
      };
    },
  };
  let broker!: InteractionBroker;
  let calls = 0;
  const f = await serverFixture({ deferActivation: true, composition,
    onStream: () => { streamStarted.resolve(); if (calls++ === 0) return hold.promise; },
    servicesFactory: registry => {
      broker = createRegistryInteractionBroker(registry, {});
      return createDaemonExecutionServices(registry, broker, composition);
    },
  });
  const server = new SessionServer({ registry: f.registry, broker,
    configuration: new TestHostConfiguration({ definitions: [], assertCurrent: () => f.registry.assertAdmission() }),
    models: f.root.runtime.session.modelRuntime, version: 'test',
  });
  cleanups.push(async () => { hold.resolve(); server.close(); await broker.drain(); await f.dispose(); });
  const context = contexts.get(f.root.sessionId)!;
  async function startAutomation() {
    const command = uuidv7();
    expect(await server.submitRemote(parseClientEnvelope({ v: 1, id: command, op: 'prompt', session: f.root.sessionId, params: { text: 'Run automation' } }),
      { command, automation: { source: 'nightly' } })).toMatchObject({ outcome: 'accepted' });
    await streamStarted.promise;
    return context.currentRun()!;
  }
  return { ...f, server, context, contexts, observations, hold, streamStarted, startAutomation };
}

it('exposes the authoritative automation run before stream wrappers and message_end handlers', async () => {
  const f = await fixture();
  expect(f.context.currentRun()).toBeUndefined();
  const run = await f.startAutomation();
  expect(run).toEqual({ id: f.store.session(f.root.sessionId).run.id, origin: { kind: 'automation', source: 'nightly' } });
  expect(f.observations.map(({ point, run }) => [point, run])).toEqual([['system', run], ['user', run], ['stream', run]]);
  Reflect.set(run, 'id', 'not-canonical');
  Reflect.set(run.origin!, 'source', 'not-canonical');
  const canonical = f.context.currentRun();
  expect(canonical).toEqual(f.observations[0]!.run);
  f.hold.resolve();
  await vi.waitFor(() => expect(f.store.session(f.root.sessionId).run.state).toBe('idle'));
  expect(f.observations.at(-1)).toMatchObject({ point: 'assistant', run: canonical });
  expect(f.context.currentRun()).toBeUndefined();
});

it.each(['follow_up', 'steer'] as const)('promotes consumed channel %s before its stream and message_end handlers', async op => {
  const f = await fixture();
  const initial = await f.startAutomation();
  const command = uuidv7(); const user = uuidv7();
  expect(await f.server.submitRemote(parseClientEnvelope({ v: 1, id: command, op, session: f.root.sessionId, params: { text: 'Channel follow-up' } }),
    { command, user, channel: { provider: 'slack' } })).toMatchObject({ outcome: 'accepted', result: { itemId: expect.any(String) } });
  expect(f.context.currentRun()).toEqual(initial);
  f.hold.resolve();
  await vi.waitFor(() => expect(f.store.session(f.root.sessionId).run.state).toBe('idle'));
  const queued = { id: initial.id, turnId: expect.any(String), origin: { kind: 'channel', provider: 'slack', user, command } };
  expect(f.observations.map(({ point, run }) => [point, run])).toEqual([
    ['system', initial], ['user', initial], ['stream', initial], ['assistant', initial],
    ['user', queued], ['stream', queued], ['assistant', queued],
  ]);
  expect(f.observations.at(-1)!.run!.turnId).not.toBe(initial.id);
  expect(f.context.currentRun()).toBeUndefined();
});

it('returns the root automation run to child session bindings, streams and message_end handlers', async () => {
  const f = await fixture();
  const rootRun = await f.startAutomation();
  const host = f.registry.executionHost(f.root.sessionId);
  const result = await host.spawnSession({ prompt: 'Review this automation', description: 'Review',
    model: { provider: 'offline', id: 'fixture' }, label: 'reviewer' });
  if (!result.ok) throw new Error(result.error.message);
  const child = result.value.executionId;
  await vi.waitFor(() => expect(host.getExecution(child)?.status).toBe('completed'));
  const childContext = f.contexts.get(child)!;
  expect(childContext.currentRun()).toEqual(rootRun);
  expect(f.store.session(child).run.id).not.toBe(rootRun.id);
  expect(f.observations.filter(observation => observation.session === child).map(({ point, run }) => [point, run]))
    .toEqual([['system', rootRun], ['user', rootRun], ['stream', rootRun], ['assistant', rootRun]]);
  f.hold.resolve();
  await host.settle();
  await vi.waitFor(() => expect(f.store.session(f.root.sessionId).run.state).toBe('idle'));
  expect(childContext.currentRun()).toBeUndefined();
});
