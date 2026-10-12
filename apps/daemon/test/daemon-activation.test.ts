import { afterEach, expect, it, vi } from 'vitest';
import { prepareRegistrySubagentHost } from '../src/daemon/runtime-bridge.js';
import { fixture, fixtures, requestId } from './fixtures/registry.js';
import { gate, serverFixture } from './fixtures/server.js';
import type { LocalSubagentNavigatorHost } from '../src/subagents/presentation.js';

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
  await f.registry.shutdown(); await expect(root.activate?.()).rejects.toThrow('disposed');
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
  const host = { listLocalSubagents: () => [] } as unknown as LocalSubagentNavigatorHost;
  const original = vi.mocked(f.profile.openSession).getMockImplementation()!;
  let reloading = false;
  vi.mocked(f.profile.openSession).mockImplementation(async request => {
    const binding = await original(request);
    return { ...binding, activate: async () => {
      if (!reloading) return;
      f.registry.bindSubagentView(binding.sessionId, host);
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
    expect(() => f.registry.bindSubagentView(root.sessionId, host)).toThrow('lifecycle operation');
    expect(() => f.registry.assertDispatch(root.sessionId)).toThrow('lifecycle operation');
  } finally { release.resolve(); }
  await reload;
  expect(f.registry.subagentView(root.sessionId)).toBe(host);
});

it('prepares subagent declarations without publishing or dispatching before activation', async () => {
  const f = await serverFixture(); fixtures.push(() => f.dispose());
  const prepared = await prepareRegistrySubagentHost(f.registry, f.root.sessionId, {
    cwd: f.cwd, agentDir: f.owner.target.agentDir, homeDir: f.directory,
    modelRuntime: f.root.runtime.session.modelRuntime, settingsManager: f.root.runtime.session.settingsManager,
    extensionPackages: [], importExtension: async () => ({ default() {} }),
  });
  fixtures.unshift(() => prepared.host.shutdown());
  await expect(prepared.host.spawn({ type: 'general', description: 'not active', prompt: 'never execute' })).rejects.toThrow('not active');
  expect(f.store.snapshot().resources).toEqual([]);
  prepared.bind(); prepared.bind(); expect(f.registry.subagentView(f.root.sessionId)).toBe(prepared.host);
});
