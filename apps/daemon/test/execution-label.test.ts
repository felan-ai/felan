import { afterEach, expect, it, vi } from 'vitest';
import { createRegistryInteractionBroker, type InteractionBroker } from '../src/daemon/broker.js';
import { createDaemonExecutionServices } from '../src/daemon/execution-services.js';
import type { SessionRuntime } from '../src/daemon/session-runtime.js';
import { createTestSessionRuntime } from './fixtures/session-runtime.js';
import { serverFixture } from './fixtures/server.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  let broker!: InteractionBroker;
  const composition = createTestSessionRuntime();
  const prepare = vi.spyOn(composition, 'prepare');
  const bindExtensions = vi.fn<NonNullable<SessionRuntime['bindExtensions']>>(async () => ({ importExtension: async () => ({ default() {} }), async dispose() {} }));
  const f = await serverFixture({ deferActivation: true, composition: { ...composition, bindExtensions },
    servicesFactory: registry => {
      broker = createRegistryInteractionBroker(registry, {});
      return createDaemonExecutionServices(registry, broker, { ...composition, bindExtensions });
    },
  });
  cleanups.push(async () => { await broker.drain(); await f.dispose(); });
  return { ...f, prepare, bindExtensions };
}

it.each(['reviewer', undefined])('passes child execution label %s to preparation and extension binding', async label => {
  const f = await fixture();
  expect(f.prepare.mock.calls[0]![0]).not.toHaveProperty('execution');
  expect(f.bindExtensions.mock.calls[0]![0]).not.toHaveProperty('execution');
  const host = f.registry.executionHost(f.root.sessionId);
  const result = await host.spawnSession({ prompt: 'Review the implementation', description: 'Review',
    model: { provider: 'offline', id: 'fixture' }, ...(label === undefined ? {} : { label }) });
  if (!result.ok) throw new Error(result.error.message);
  const id = result.value.executionId;
  const execution = label === undefined ? {} : { label };
  expect(f.prepare.mock.calls.find(([context]) => context.session.id === id)?.[0].execution).toEqual(execution);
  expect(f.bindExtensions.mock.calls.find(([context]) => context.sessionManager.getSessionId() === id)?.[0].execution).toEqual(execution);
  await vi.waitFor(() => expect(host.getExecution(id)?.status).toBe('completed'));
  await host.settle();
  expect(await f.registry.evictIdle()).toContain(id);
  f.prepare.mockClear(); f.bindExtensions.mockClear();
  await f.registry.restore(id);
  expect(f.prepare.mock.calls.find(([context]) => context.session.id === id)?.[0].execution).toEqual(execution);
  expect(f.bindExtensions.mock.calls.find(([context]) => context.sessionManager.getSessionId() === id)?.[0].execution).toEqual(execution);
});
