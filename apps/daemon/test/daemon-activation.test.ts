import { afterEach, expect, it, vi } from 'vitest';
import { fixture, fixtures, requestId } from './fixtures/registry.js';
import { gate, serverFixture } from './fixtures/server.js';
import { registrySessionExecutions } from '../src/daemon/session-services.js';

afterEach(async () => { for (const dispose of fixtures.splice(0)) await dispose(); });

it('activates extensions once after the real session is registered', async () => {
  let current: Awaited<ReturnType<typeof serverFixture>> | undefined;
  let starts = 0;
  const registered: boolean[] = [];
  const f = await serverFixture({ deferActivation: true, extension: pi => pi.on('session_start', (_event, context) => {
    starts++; if (current) registered.push(current.registry.binding(context.sessionManager.getSessionId())?.runtime.session.sessionId === context.sessionManager.getSessionId());
  }) });
  current = f; fixtures.push(() => f.dispose());
  const root = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
  expect(starts).toBe(2); expect(registered).toEqual([true]); await root.activate?.(); expect(starts).toBe(2);
  await f.registry.shutdown(); await expect(root.activate?.()).rejects.toThrow('Session binding is disposing.');
});

it('cleans up activated services before removing a failed opening', async () => {
  const f = await fixture(); const dispose = vi.fn(async () => {}); const settle = vi.fn(async () => {});
  const original = vi.mocked(f.profile.openSession).getMockImplementation()!;
  vi.spyOn(f.profile, 'openSession').mockImplementation(async request => {
    const binding = await original(request);
    return { ...binding, activate: async () => {
      f.registry.registerService(binding.sessionId, { busy: () => false, settle, dispose });
      throw new Error('activation failed');
    } };
  });
  await expect(f.registry.create({ cwd: f.cwd, target: { kind: 'new' } })).rejects.toThrow('activation failed');
  expect(settle).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce();
  const row = f.store.snapshot().sessions[0]!; expect(row.residency).toBe('evicted'); expect(f.registry.binding(row.id)).toBeUndefined();
  expect(() => f.owner.assertCurrent()).not.toThrow();
});

it('binds a replacement view inside activation while keeping reload dispatch and external binding fenced', async () => {
  const f = await fixture(); const entered = gate(); const release = gate();
  const original = vi.mocked(f.profile.openSession).getMockImplementation()!;
  let reloading = false;
  vi.mocked(f.profile.openSession).mockImplementation(async request => {
    const binding = await original(request);
    return { ...binding, activate: async () => {
      if (!reloading) return;
      expect(f.registry.executionHost(binding.sessionId)).toBeDefined();
      expect(() => f.registry.assertDispatch(binding.sessionId)).toThrow('lifecycle operation');
      entered.resolve(); await release.promise;
    } };
  });
  const root = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
  const id = requestId(); f.store.admit({ v: 1, id, op: 'session.reload', session: root.sessionId, params: {} }, 'client');
  reloading = true;
  const reload = f.registry.reloadAdmitted(id, root.sessionId);
  try {
    await Promise.race([entered.promise, reload.then(() => { throw new Error('Reload completed before the activation barrier'); })]);
    expect(() => registrySessionExecutions(f.registry, root.sessionId)).toThrow('lifecycle operation');
    expect(() => f.registry.assertDispatch(root.sessionId)).toThrow('lifecycle operation');
  } finally { release.resolve(); }
  await reload;
  expect(await registrySessionExecutions(f.registry, root.sessionId).executions()).toEqual({ items: [] });
});
