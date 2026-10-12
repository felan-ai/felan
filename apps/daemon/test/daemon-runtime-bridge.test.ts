import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostAgentRuntime, InMemoryCredentialStore, ModelRuntime, createAssistantMessageEventStream, type Api, type Model } from '@felan-ai/agent-core';
import { createLocalDaemonProfile } from '../src/daemon/local-profile.js';
import { SessionRegistry } from '../src/daemon/registry.js';
import { createRegistrySubagentHost } from '../src/daemon/runtime-bridge.js';
import { LocalSubagentHost, type LocalSubagentRunner } from '../src/subagents/host.js';
import { LocalSubagentStore } from '../src/subagents/store.js';
import { builtinExtensionPackages } from '../src/extension-catalog.js';
import { assistant, deferred, fixture, fixtures, realFixture, requestId, supported } from './fixtures/registry.js';

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
    const profile = await createLocalDaemonProfile({ runtimeFactory: request => registry.wrapOpeningRuntime(new HostAgentRuntime(request.cwd, request), request.rootSessionId), agentDir: f.owner.target.agentDir, initializeProcess: async () => ({ diagnostics: [], assertConfiguration: () => [] }), createModelRuntime: fakeModels });
    fixtures.push(() => profile.dispose());
    registry = new SessionRegistry({ owner: f.owner, store: f.store, profile, services: ({ getExecutionPolicy }) => ({ getExecutionPolicy,
      extensions: { configuration: async () => [], bind: async () => ({ importExtension: async () => ({ default() {} }), wrapStreamFunction: stream => stream, dispose: async () => {} }) } }) });
    f.replaceRegistry(registry, f.store);
    const root = await registry.create({ cwd: f.cwd, target: { kind: 'new' }, model });
    const request = requestId(); f.store.admit({ v: 1, id: request, op: 'prompt', session: root.sessionId, params: { text: 'root' } }, 'owner');
    await registry.runAdmitted(request, root.sessionId, { kind: 'headless', attachment: 'fixture' }, session => session.prompt('root'));
    expect(registry.projection(root.sessionId).snapshot().history.entries.at(-1)?.content).toEqual([{ type: 'text', text: 'done' }]);
    registry.tightenPolicy(root.sessionId);
    const host = await createRegistrySubagentHost(registry, root.sessionId, { cwd: f.cwd, agentDir: f.owner.target.agentDir,
      modelRuntime: root.runtime.session.modelRuntime, settingsManager: root.runtime.session.settingsManager,
      extensionPackages: [], importExtension: async () => ({ default() {} }) });
    const child = await host.spawn({ type: 'general', description: 'offline child', prompt: 'child', model: 'offline/fixture' });
    expect(child.ok).toBe(true); if (!child.ok) return;
    const result = await new Promise<import('@felan-ai/ext-subagents').SubagentRecord>((resolve, reject) => {
      let unsubscribe = () => {};
      const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Child did not complete')); }, 4000);
      f.releases.add(() => { clearTimeout(timeout); unsubscribe(); });
      unsubscribe = host.subscribe(records => { const done = records.find(row => row.agentId === child.value.agentId && row.status === 'completed'); if (done) { clearTimeout(timeout); queueMicrotask(() => unsubscribe()); resolve(done); } });
    });
    expect(result.status).toBe('completed');
    await host.shutdown();
    const view = host.getLocalSubagent(child.value.agentId)!;
    expect(view.sessionId).toBeDefined(); expect(view.sessionId).not.toBe(child.value.agentId);
    const owned = registry.binding(view.sessionId!)!;
    expect(owned.rootSessionId).toBe(root.sessionId);
    expect(owned.agentRuntime.storage('session').root).toBe(root.agentRuntime.storage('session').root);
    expect(registry.getPolicy(owned.sessionId).mode).toBe('acp-strict');
    expect(f.store.snapshot().resources.find(row => row.id === child.value.agentId)).toMatchObject({ root: root.sessionId, state: 'exited' });
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
    const host = await createRegistrySubagentHost(f.registry, f.root.sessionId, childOptions(f, 1));
    await host.spawn({ type: 'general', description: 'first', prompt: 'first', model: 'offline/fixture' });
    await vi.waitFor(() => expect(calls).toBe(1));
    const second = await host.spawn({ type: 'general', description: 'queued', prompt: 'second', model: 'offline/fixture' });
    expect(second.ok).toBe(true); if (!second.ok) return;
    expect(host.getLocalSubagent(second.value.agentId)?.status).toBe('queued');
    expect(f.registry.tightenPolicy(f.root.sessionId).pending).toBeDefined();
    gate.resolve();
    await vi.waitFor(() => expect(host.getLocalSubagent(second.value.agentId)?.status).toBe('completed'), { timeout: 4000 });
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
    const host = await createRegistrySubagentHost(f.registry, f.root.sessionId, childOptions(f));
    const child = await host.spawn({ type: 'general', description: 'opening', prompt: 'child', model: 'offline/fixture' });
    expect(child.ok).toBe(true); if (!child.ok) return;
    await entered.promise;
    expect(f.registry.tightenPolicy(f.root.sessionId).effective).toBe('acp-strict');
    gate.resolve();
    await vi.waitFor(() => expect(host.getLocalSubagent(child.value.agentId)?.status).toBe('completed'), { timeout: 4000 });
    expect(observed[0]).toMatchObject({ mode: 'acp-strict', pendingTightening: false });
    expect(f.registry.getPolicy(host.getLocalSubagent(child.value.agentId)!.sessionId!)).toMatchObject({ mode: 'acp-strict', pendingTightening: false });
    await host.settle();
  });

  it('binds a retained child only once across continuations without leaking listeners', async () => {
    const f = await realFixture();
    const host = await createRegistrySubagentHost(f.registry, f.root.sessionId, childOptions(f));
    const child = await host.spawn({ type: 'general', description: 'retained', prompt: 'first', model: 'offline/fixture' });
    expect(child.ok).toBe(true); if (!child.ok) return;
    await vi.waitFor(() => expect(host.getLocalSubagent(child.value.agentId)?.status).toBe('completed'), { timeout: 4000 });
    await host.settle();
    const session = f.registry.binding(host.getLocalSubagent(child.value.agentId)!.sessionId!)!.runtime.session;
    const original = session.subscribe.bind(session); let live = 0;
    session.subscribe = callback => { live++; const off = original(callback); return () => { live--; off(); }; };
    for (const message of ['second', 'third']) {
      expect((await host.steer(child.value.agentId, message)).ok).toBe(true);
      await vi.waitFor(() => expect(host.getLocalSubagent(child.value.agentId)?.status).toBe('completed'), { timeout: 4000 });
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
      const host = await createRegistrySubagentHost(f.registry, f.root.sessionId, childOptions(f, 1));
      const first = await host.spawn({ type: 'general', description: 'first', prompt: 'first', model: 'offline/fixture' });
      await vi.waitFor(() => expect(calls).toBe(1));
      const second = await host.spawn({ type: 'general', description: 'second', prompt: 'second', model: 'offline/fixture' });
      expect(first.ok && second.ok).toBe(true); if (!first.ok || !second.ok) return;
      f.registry.tightenPolicy(f.root.sessionId); childGate.resolve();
      await vi.waitFor(() => expect(host.getLocalSubagent(first.value.agentId)?.status).toBe('completed'));
      await host.settle();
      expect(f.registry.getPolicy(f.root.sessionId).pendingTightening).toBe(true);
      expect(host.getLocalSubagent(second.value.agentId)?.status).toBe('queued');
      const wake = vi.spyOn(host, 'resumeQueued');
      if (outcome === 'fails cancellation') {
        const abort = vi.spyOn(f.root.runtime.session, 'abort').mockRejectedValueOnce(new Error('abort failed'));
        await expect(f.registry.cancel(f.root.sessionId)).rejects.toThrow('abort failed'); abort.mockRestore();
        await host.settle();
        expect(wake).not.toHaveBeenCalled();
        expect(host.getLocalSubagent(second.value.agentId)?.status).toBe('queued');
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
          expect(host.getLocalSubagent(second.value.agentId)?.status).toBe('cancelled');
          return;
        }
        if (outcome === 'is fenced during cancellation') {
          const fault = f.registry as unknown as { fence(error: Error): void; failure?: unknown; failureSettlement?: Promise<void> };
          fault.fence(new Error('fenced during cancel')); rootGate.resolve();
          await Promise.all([cancellation, rootWork, f.registry.settleWriters()]); await host.settle();
          expect(wake).not.toHaveBeenCalled(); expect(starts).toHaveLength(1);
          expect(host.getLocalSubagent(second.value.agentId)?.status).toBe('cancelled');
          delete fault.failure; delete fault.failureSettlement;
          return;
        }
        rootGate.resolve(); await Promise.all([cancellation, rootWork]);
      } else { rootGate.resolve(); await rootWork; }
      await vi.waitFor(() => expect(host.getLocalSubagent(second.value.agentId)?.status).toBe('completed'), { timeout: 4000 });
      expect(observed[1]).toMatchObject({ mode: 'acp-strict', pendingTightening: false });
      await host.settle();
      expect(starts).toHaveLength(2); expect(new Set(starts).size).toBe(2);
    });
  }
});

describe.skipIf(!supported)('subagent persistence settlement', () => {
  it('reconciles an observed save failure only after a later full snapshot succeeds', async () => {
    const f = await persistenceHost(); const error = new Error('save rejected');
    f.save.mockRejectedValueOnce(error);
    expect(await f.host.spawn(persistenceRequest('rejected'))).toMatchObject({ ok: false, error: { code: 'host_unavailable' } });
    const second = await f.host.spawn(persistenceRequest('saved'));
    expect(second.ok).toBe(true); if (!second.ok) return;
    await expect(f.host.settle()).resolves.toBeUndefined();
    expect((await f.store.load()).map(row => row.record.agentId)).toEqual([second.value.agentId]);
    await expect(f.host.shutdown()).resolves.toBeUndefined();
    expect((await f.store.load())[0]?.record.status).toBe('cancelled');
  });

  it('rejects settlement and shutdown when an observed save failure has no successful replacement', async () => {
    const f = await persistenceHost(); const error = new Error('unreconciled save'); f.expectShutdownFailure();
    f.save.mockRejectedValueOnce(error);
    expect(await f.host.spawn(persistenceRequest('rejected'))).toMatchObject({ ok: false });
    await expect(f.host.settle()).rejects.toMatchObject({ errors: [error] });
    await f.write.call(new LocalSubagentStore(f.owner.target.agentDir, 'unrelated'), []);
    await expect(f.host.settle()).rejects.toMatchObject({ errors: [error] });
    await expect(f.host.shutdown()).rejects.toMatchObject({ errors: [error] });
  });

  it('does not retain a rejected tail captured before reconciliation finishes during drain', async () => {
    const f = await persistenceHost(); const firstGate = deferred(); const firstEntered = deferred();
    const secondGate = deferred(); const secondEntered = deferred(); f.releases.add(firstGate.resolve); f.releases.add(secondGate.resolve);
    const write = f.write;
    f.save.mockImplementationOnce(async () => { firstEntered.resolve(); await firstGate.promise; throw new Error('old tail'); });
    f.save.mockImplementationOnce(async function (rows) { secondEntered.resolve(); await secondGate.promise; await write.call(this, rows); });
    const first = f.host.spawn(persistenceRequest('rejected')); await firstEntered.promise;
    let returned = false; const settled = f.host.settle().then(() => { returned = true; });
    const second = f.host.spawn(persistenceRequest('saved')); firstGate.resolve();
    await secondEntered.promise; expect(await first).toMatchObject({ ok: false });
    await new Promise<void>(resolve => setImmediate(resolve)); expect(returned).toBe(false);
    secondGate.resolve(); const result = await second; await settled;
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect((await f.store.load()).map(row => row.record.agentId)).toEqual([result.value.agentId]);
    await expect(f.host.shutdown()).resolves.toBeUndefined();
  });

  it('does not let an older successful save clear a newer queued save failure', async () => {
    const f = await persistenceHost(); const entered = deferred(); const gate = deferred(); f.releases.add(gate.resolve);
    const write = f.write; const error = new Error('newer tail');
    f.save.mockImplementationOnce(async function (rows) { entered.resolve(); await gate.promise; await write.call(this, rows); });
    f.save.mockRejectedValueOnce(error);
    const first = f.host.spawn(persistenceRequest('older success')); await entered.promise;
    const second = f.host.spawn(persistenceRequest('newer failure'));
    const settled = f.host.settle().then(() => undefined, caught => caught);
    gate.resolve(); expect(await first).toMatchObject({ ok: true }); expect(await second).toMatchObject({ ok: false });
    expect(await settled).toMatchObject({ errors: [error] });
    expect((await f.store.load()).map(row => row.record.description)).toEqual(['older success']);
  });

  it('does not forgive a cancellation cleanup failure after another full snapshot succeeds', async () => {
    const ready = deferred(); const released = deferred(); const error = new Error('cleanup failed');
    const f = await persistenceHost(async input => {
      if (input.request.description === 'bad cleanup') {
        await input.onReady({ steer: async () => {}, cancel: async () => { released.resolve(); throw error; } });
        ready.resolve(); await released.promise;
      }
      return { result: 'done' };
    });
    f.releases.add(released.resolve); f.expectShutdownFailure();
    const first = await f.host.spawn(persistenceRequest('bad cleanup'));
    expect(first.ok).toBe(true); if (!first.ok) return;
    await ready.promise; await f.host.cancel(first.value.agentId);
    await expect(f.host.settle()).rejects.toMatchObject({ errors: [error] });
    const second = await f.host.spawn(persistenceRequest('good cleanup'));
    expect(second.ok).toBe(true); if (!second.ok) return;
    await vi.waitFor(() => expect(f.host.getLocalSubagent(second.value.agentId)?.status).toBe('completed'));
    await f.host.getResult(second.value.agentId);
    expect((await f.store.load()).find(row => row.record.agentId === second.value.agentId)?.record.status).toBe('completed');
    await expect(f.host.settle()).rejects.toMatchObject({ errors: [error] });
    await expect(f.host.shutdown()).rejects.toMatchObject({ errors: [error] });
  });
});

async function persistenceHost(runChild?: LocalSubagentRunner) {
  const f = await realFixture(); const root = 'persistence-settlement';
  const host = await LocalSubagentHost.create({ ...childOptions(f), sessionId: root,
    lifecycle: { assertCurrent: () => f.owner.assertCurrent(), beforeAdmission: () => {},
      beforeDispatch: () => { if (!runChild) throw new Error('Fixture dispatch is held'); }, beforeCompletion: () => {}, recordsChanged: () => {} },
    ...(runChild ? { runChild } : {}),
  });
  const store = new LocalSubagentStore(f.owner.target.agentDir, root);
  const write = LocalSubagentStore.prototype.save;
  const save = vi.spyOn(LocalSubagentStore.prototype, 'save');
  let expected = false;
  fixtures.unshift(async () => {
    save.mockRestore(); for (const release of f.releases) release();
    try { await host.shutdown(); } catch (error) { if (!expected) throw error; }
  });
  return { ...f, host, store, save, write, expectShutdownFailure: () => { expected = true; } };
}

function persistenceRequest(description: string) {
  return { type: 'general', description, prompt: description, model: 'offline/fixture' };
}

function childOptions(f: Awaited<ReturnType<typeof realFixture>>, concurrency = 2) {
  return { cwd: f.cwd, agentDir: f.owner.target.agentDir, modelRuntime: f.root.runtime.session.modelRuntime,
    settingsManager: f.root.runtime.session.settingsManager, extensionPackages: [], settings: { concurrency },
    importExtension: async () => ({ default() {} }) };
}
