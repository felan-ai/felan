import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostAgentRuntime, InMemoryCredentialStore, ModelRuntime, createAssistantMessageEventStream, type Api, type Model } from '@felan-ai/agent-core';
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
    f.registry.tightenPolicy(f.root.sessionId);
    expect(f.registry.getPolicy(f.root.sessionId).mode).toBe('acp-strict');
    gate.resolve();
    const child = await pending; expect(child.ok).toBe(true); if (!child.ok) return;
    await vi.waitFor(() => expect(host.getExecution(child.value.executionId)?.status).toBe('completed'), { timeout: 4000 });
    expect(observed[0]).toMatchObject({ mode: 'acp-strict' });
    expect(f.registry.getPolicy(host.getExecution(child.value.executionId)!.sessionId!)).toMatchObject({ mode: 'acp-strict' });
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

});


function childOptions(f: Awaited<ReturnType<typeof realFixture>>, concurrency = 2) {
  return { cwd: f.cwd, agentDir: f.owner.target.agentDir, modelRuntime: f.root.runtime.session.modelRuntime,
    settings: { concurrency } };
}
