import { afterEach, expect, it, vi } from 'vitest';
import { LIMITS } from '@felan-ai/session-protocol';
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

it('classifies exhausted presentation slots as capacity and accepts a new slot after removal', async () => {
  const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
  const projection = f.registry.projection(binding.sessionId);
  projection.setPresentation({ id: 'slot-0', kind: 'status', key: 'working', value: { kind: 'text', text: '' }, fallback: 'Status' });
  const publish = vi.spyOn(projection, 'publish').mockImplementation(() => {});
  try {
    for (let index = 1; index < LIMITS.pageEntries; index++) projection.setPresentation({ id: `slot-${index}`, kind: 'status', key: 'working', value: { kind: 'text', text: '' }, fallback: 'Status' });
    expect(projection.snapshot().presentation).toHaveLength(LIMITS.pageEntries);
    publish.mockClear();
    expect(() => projection.setPresentation({ id: 'new-slot', kind: 'status', key: 'working', value: { kind: 'text', text: '' }, fallback: 'Status' })).toThrow(expect.objectContaining({ code: 'request_capacity' }));
    expect(publish).not.toHaveBeenCalled();
  } finally { publish.mockRestore(); }
  projection.setPresentation({ id: 'slot-0', remove: true });
  expect(() => projection.setPresentation({ id: 'new-slot', kind: 'status', key: 'working', value: { kind: 'text', text: '' }, fallback: 'Status' })).not.toThrow();
  expect(() => f.registry.assertAdmission()).not.toThrow();
});
