import { afterEach, expect, it } from 'vitest';
import { registrySessionExecutions } from '../../../daemon/src/daemon/session-services.js';
import { fixture, fixtures } from '../../../daemon/test/fixtures/registry.js';

afterEach(async () => { for (const cleanup of fixtures.splice(0)) await cleanup(); });

it('publishes registry execution invalidations without a subagent presentation', async () => {
  const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
  const before = f.registry.projection(binding.sessionId).snapshot();
  const child = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, parentSessionId: binding.sessionId, rootSessionId: binding.sessionId,
    execution: { request: { prompt: 'work', description: 'queued' }, createdAt: new Date().toISOString(), deliveryId: 'delivery', completionPending: false } });
  const port = registrySessionExecutions(f.registry, binding.sessionId);
  expect((await port.executions()).items).toHaveLength(1);
  await port.cancel(child.sessionId);
  const after = f.registry.projection(binding.sessionId).snapshot();
  expect(after.executionsGeneration).toMatch(/^[a-f0-9]{64}$/);
  expect(after.executionsGeneration).not.toBe(before.executionsGeneration);
  expect(after.presentation).toEqual([]);
});

