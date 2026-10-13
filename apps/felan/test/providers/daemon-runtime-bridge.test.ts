import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostAgentRuntime, InMemoryCredentialStore, ModelRuntime, SessionManager, type AgentSession, createAssistantMessageEventStream, type Api, type Model } from '@felan-ai/agent-core';
import { createTestSessionLifecycle } from '../../../daemon/test/fixtures/session-runtime.js';
import { SessionRegistry } from '../../../daemon/src/daemon/registry.js';
import { registeredExecutionHost as createRegistryExecutionHost } from './fixtures/execution-port.js';
import { builtinExtensionPackages } from '../../src/providers/extension-catalog.js';
import { assistant, deferred, fixture, fixtures, realFixture, requestId, supported } from '../../../daemon/test/fixtures/registry.js';

const model: Model<Api> = { id: 'fixture', name: 'Fixture', api: 'openai-completions', provider: 'offline', baseUrl: 'https://example.invalid', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 };
afterEach(async () => { for (const cleanup of fixtures.splice(0)) await cleanup(); });

describe.skipIf(!supported)('real profile / subagent registry bridge', () => {
  it('uses actual child manager IDs, root storage, inherited policy and actual AgentSession events', async () => {
    const f = await fixture(); await f.registry.shutdown();
    let calls = 0;
    const fakeModels = async () => {
      const models = await ModelRuntime.create({ modelsPath: null, credentials: new InMemoryCredentialStore(), refreshOnCreate: false });
      models.registerProvider('offline', { api: 'openai-completions', baseUrl: model.baseUrl, apiKey: 'fixture', models: [model], streamSimple: () => {
        calls++; const stream = createAssistantMessageEventStream(); const message = assistant();
        queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message })); return stream;
      } });
      return models;
    };
    await writeFile(join(f.owner.target.agentDir, 'settings.json'), JSON.stringify({ builtinExtensions: Object.fromEntries(Object.keys(builtinExtensionPackages).map(name => [name, false])) }));
    let registry: SessionRegistry;
    const profile = await createTestSessionLifecycle({ runtimeFactory: request => registry.wrapOpeningRuntime(new HostAgentRuntime(request.cwd, request), request.rootSessionId), agentDir: f.owner.target.agentDir, initializeProcess: async () => ({ diagnostics: [], assertConfiguration: () => [] }), createModelRuntime: fakeModels });
    fixtures.push(() => profile.dispose());
    registry = new SessionRegistry({ owner: f.owner, store: f.store, lifecycle: profile, services: ({ getExecutionPolicy }) => ({ getExecutionPolicy,
      extensions: { configuration: async () => [], bind: async () => ({ importExtension: async () => ({ default() {} }), wrapStreamFunction: stream => stream, dispose: async () => {} }) } }) });
    f.replaceRegistry(registry, f.store);
    const root = await registry.create({ cwd: f.cwd, target: { kind: 'new' }, model });
    const request = requestId(); f.store.admit({ v: 1, id: request, op: 'prompt', session: root.sessionId, params: { text: 'root' } }, 'owner');
    await registry.runAdmitted(request, root.sessionId, { kind: 'headless', attachment: 'fixture' }, session => session.prompt('root'));
    expect(registry.projection(root.sessionId).snapshot().history.entries.at(-1)?.content).toEqual([{ type: 'text', text: 'done' }]);
    registry.tightenPolicy(root.sessionId);
    const host = await createRegistryExecutionHost(registry, root.sessionId, { cwd: f.cwd, agentDir: f.owner.target.agentDir,
      modelRuntime: root.runtime.session.modelRuntime,  });
    const child = await host.spawnSession({ label: 'general', description: 'offline child', prompt: 'child', model: { provider: 'offline', id: 'fixture' } });
    expect(child.ok).toBe(true); if (!child.ok) return;
    const result = await new Promise<import('@felan-ai/daemon/provider').ExecutionRecord>((resolve, reject) => {
      let unsubscribe = () => {};
      const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Child did not complete')); }, 4000);
      f.releases.add(() => { clearTimeout(timeout); unsubscribe(); });
      unsubscribe = host.subscribe(records => { const done = records.find(row => row.executionId === child.value.executionId && row.status === 'completed'); if (done) { clearTimeout(timeout); queueMicrotask(() => unsubscribe()); resolve(done); } });
    });
    expect(result.status).toBe('completed');
    await host.shutdown();
    const view = host.getExecution(child.value.executionId)!;
    expect(view.sessionId).toBeDefined(); expect(view.sessionId).toBe(child.value.executionId);
    const owned = registry.binding(view.sessionId!)!;
    expect(owned.rootSessionId).toBe(root.sessionId);
    expect(owned.agentRuntime.storage('session').root).toBe(root.agentRuntime.storage('session').root);
    expect(registry.getPolicy(owned.sessionId).mode).toBe('acp-strict');
    expect(f.store.session(child.value.executionId)).toMatchObject({ root: root.sessionId, execution: { outcome: 'completed' } });
    const process = await owned.agentRuntime.processes!.startShell('printf child');
    let snapshot = await process.read(0, { waitMs: 1000 });
    if (snapshot.running) snapshot = await process.read(snapshot.nextOffset, { waitMs: 1000 });
    expect(snapshot.running).toBe(false);
    expect(registry.processes.list(root.sessionId).some(row => row.session === owned.sessionId)).toBe(true);
    const before = calls;
    await registry.shutdown();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(calls).toBe(before);
  });

  it('activates strict policy ahead of queued dispatch rather than counting reservations as active effects', async () => {
    const gate = deferred(); let calls = 0;
    const observed: ReturnType<SessionRegistry['getPolicy']>[] = [];
    const f = await realFixture(async () => { calls++; observed.push(f.registry.getPolicy(f.root.sessionId)); if (calls === 1) await gate.promise; });
    f.releases.add(gate.resolve);
    const host = await createRegistryExecutionHost(f.registry, f.root.sessionId, childOptions(f, 1));
    await host.spawnSession({ label: 'general', description: 'first', prompt: 'first', model: { provider: 'offline', id: 'fixture' } });
    await vi.waitFor(() => expect(calls).toBe(1));
    const second = await host.spawnSession({ label: 'general', description: 'queued', prompt: 'second', model: { provider: 'offline', id: 'fixture' } });
    expect(second.ok).toBe(true); if (!second.ok) return;
    expect(host.getExecution(second.value.executionId)?.status).toBe('queued');
    expect(f.registry.tightenPolicy(f.root.sessionId).pending).toBeDefined();
    gate.resolve();
    await vi.waitFor(() => expect(host.getExecution(second.value.executionId)?.status).toBe('completed'), { timeout: 4000 });
    expect(observed[1]).toMatchObject({ mode: 'acp-strict', pendingTightening: false });
    await host.settle();
  });

  it('rechecks inherited policy after asynchronous child opening', async () => {
    const gate = deferred(); const entered = deferred(); const observed: ReturnType<SessionRegistry['getPolicy']>[] = [];
    const f = await realFixture(async () => { observed.push(f.registry.getPolicy(f.root.sessionId)); });
    f.releases.add(gate.resolve);
    const original = f.profile.openSession; let held = false;
    vi.spyOn(f.profile, 'openSession').mockImplementation(async request => {
      const result = await original(request);
      if (request.parentSessionId && !held) { held = true; entered.resolve(); await gate.promise; }
      return result;
    });
    const host = await createRegistryExecutionHost(f.registry, f.root.sessionId, childOptions(f));
    const pending = host.spawnSession({ label: 'general', description: 'opening', prompt: 'child', model: { provider: 'offline', id: 'fixture' } });
    await entered.promise;
    expect(f.registry.tightenPolicy(f.root.sessionId).effective).toBe('acp-strict');
    gate.resolve();
    const child = await pending; expect(child.ok).toBe(true); if (!child.ok) return;
    await vi.waitFor(() => expect(host.getExecution(child.value.executionId)?.status).toBe('completed'), { timeout: 4000 });
    expect(observed[0]).toMatchObject({ mode: 'acp-strict', pendingTightening: false });
    expect(f.registry.getPolicy(host.getExecution(child.value.executionId)!.sessionId!)).toMatchObject({ mode: 'acp-strict', pendingTightening: false });
    await host.settle();
  });

  it('binds a retained child only once across continuations without leaking listeners', async () => {
    const f = await realFixture();
    const host = await createRegistryExecutionHost(f.registry, f.root.sessionId, childOptions(f));
    const child = await host.spawnSession({ label: 'general', description: 'retained', prompt: 'first', model: { provider: 'offline', id: 'fixture' } });
    expect(child.ok).toBe(true); if (!child.ok) return;
    await vi.waitFor(() => expect(host.getExecution(child.value.executionId)?.status).toBe('completed'), { timeout: 4000 });
    await host.settle();
    const session = f.registry.binding(host.getExecution(child.value.executionId)!.sessionId!)!.runtime.session;
    const original = session.subscribe.bind(session); let live = 0;
    session.subscribe = callback => { live++; const off = original(callback); return () => { live--; off(); }; };
    for (const message of ['second', 'third']) {
      expect((await host.steer(child.value.executionId, message)).ok).toBe(true);
      await vi.waitFor(() => expect(host.getExecution(child.value.executionId)?.status).toBe('completed'), { timeout: 4000 });
      await host.settle(); expect(live).toBe(0);
    }
    session.subscribe = original;
  });

  for (const outcome of ['settles', 'is cancelled', 'fails cancellation', 'closes during cancellation', 'is fenced during cancellation'] as const) {
    it(`handles a policy-blocked child when a separate root operation ${outcome}`, async () => {
      const rootGate = deferred(); const childGate = deferred(); let calls = 0;
      const observed: ReturnType<SessionRegistry['getPolicy']>[] = [];
      const f = await realFixture(async () => { calls++; observed.push(f.registry.getPolicy(f.root.sessionId)); if (calls === 1) await childGate.promise; });
      f.releases.add(rootGate.resolve); f.releases.add(childGate.resolve);
      const starts: string[] = []; const subscriptions: Array<() => void> = [];
      fixtures.push(async () => { for (const off of subscriptions) off(); });
      const original = f.profile.openSession;
      vi.spyOn(f.profile, 'openSession').mockImplementation(async request => {
        const binding = await original(request);
        if (request.parentSessionId) subscriptions.push(binding.runtime.session.subscribe(event => {
          if (event.type === 'agent_start') starts.push(binding.sessionId);
        }));
        return binding;
      });
      const id = requestId(); f.store.admit({ v: 1, id, op: 'prompt', session: f.root.sessionId, params: { text: 'root blocker' } }, 'owner');
      const rootWork = f.registry.runAdmitted(id, f.root.sessionId, { kind: 'headless', attachment: 'fixture' }, () => rootGate.promise);
      const host = await createRegistryExecutionHost(f.registry, f.root.sessionId, childOptions(f, 1));
      const first = await host.spawnSession({ label: 'general', description: 'first', prompt: 'first', model: { provider: 'offline', id: 'fixture' } });
      await vi.waitFor(() => expect(calls).toBe(1));
      const second = await host.spawnSession({ label: 'general', description: 'second', prompt: 'second', model: { provider: 'offline', id: 'fixture' } });
      expect(first.ok && second.ok).toBe(true); if (!first.ok || !second.ok) return;
      f.registry.tightenPolicy(f.root.sessionId); childGate.resolve();
      await vi.waitFor(() => expect(host.getExecution(first.value.executionId)?.status).toBe('completed'));
      await host.settle();
      expect(f.registry.getPolicy(f.root.sessionId).pendingTightening).toBe(true);
      expect(host.getExecution(second.value.executionId)?.status).toBe('queued');
      const wake = vi.spyOn(host, 'resumeQueued');
      if (outcome === 'fails cancellation') {
        const abort = vi.spyOn(f.root.runtime.session, 'abort').mockRejectedValueOnce(new Error('abort failed'));
        await expect(f.registry.cancel(f.root.sessionId)).rejects.toThrow('abort failed'); abort.mockRestore();
        await host.settle();
        expect(wake).not.toHaveBeenCalled();
        expect(host.getExecution(second.value.executionId)?.status).toBe('queued');
        expect(starts).toHaveLength(1);
        const closing = f.registry.close(f.root.sessionId); rootGate.resolve(); await Promise.all([closing, rootWork]);
        return;
      }
      if (outcome !== 'settles') {
        const cancellation = f.registry.cancel(f.root.sessionId);
        await vi.waitFor(() => expect(f.store.session(f.root.sessionId).run.state).toBe('cancelling'));
        expect(() => f.registry.assertDispatch(f.root.sessionId)).toThrow('cancelling');
        if (outcome === 'closes during cancellation') {
          const closing = f.registry.close(f.root.sessionId); rootGate.resolve();
          await Promise.all([cancellation, closing, rootWork]); await host.settle();
          expect(wake).not.toHaveBeenCalled(); expect(starts).toHaveLength(1);
          expect(host.getExecution(second.value.executionId)?.status).toBe('cancelled');
          return;
        }
        if (outcome === 'is fenced during cancellation') {
          const fault = f.registry as unknown as { fence(error: Error): void; failure?: unknown; failureSettlement?: Promise<void> };
          fault.fence(new Error('fenced during cancel')); rootGate.resolve();
          await Promise.all([cancellation, rootWork, f.registry.settleWriters()]); await host.settle();
          expect(wake).not.toHaveBeenCalled(); expect(starts).toHaveLength(1);
          expect(host.getExecution(second.value.executionId)?.status).toBe('cancelled');
          delete fault.failure; delete fault.failureSettlement;
          return;
        }
        rootGate.resolve(); await Promise.all([cancellation, rootWork]);
      } else { rootGate.resolve(); await rootWork; }
      await vi.waitFor(() => expect(host.getExecution(second.value.executionId)?.status).toBe('completed'), { timeout: 4000 });
      expect(observed[1]).toMatchObject({ mode: 'acp-strict', pendingTightening: false });
      await host.settle();
      expect(starts).toHaveLength(2); expect(new Set(starts).size).toBe(2);
    });
  }
});


function childOptions(f: Awaited<ReturnType<typeof realFixture>>, concurrency = 2) {
  return { cwd: f.cwd, agentDir: f.owner.target.agentDir, modelRuntime: f.root.runtime.session.modelRuntime,
    settings: { concurrency } };
}
