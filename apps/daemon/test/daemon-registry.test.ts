import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionAPI } from '@felan-ai/agent-core';
import type { KnownSessionChange, SessionEvent } from '@felan-ai/session-protocol';
import { DaemonControlStore } from '../src/daemon/control-store.js';
import { ControlStoreError } from '../src/daemon/control-state.js';
import type { SessionExtensionContext } from '../src/daemon/provider.js';
import { assistant, deferred, fixture, fixtures, now, realFixture, requestId, supported } from './fixtures/registry.js';

afterEach(async () => { for (const cleanup of fixtures.splice(0)) await cleanup(); });

function hasChangeType<T extends KnownSessionChange['type']>(change: SessionEvent['change'], type: T): change is Extract<KnownSessionChange, { type: T }> {
  return change.type === type;
}

describe.skipIf(!supported)('daemon session registry', () => {
  it.each([
    { name: 'without prompt options', systemPromptOptions: undefined },
    { name: 'without sections', systemPromptOptions: {} },
    { name: 'with sections', systemPromptOptions: { sections: { session_tasks: 'Task context' } } },
  ])('adds child instructions $name', async ({ systemPromptOptions }) => {
    const f = await fixture();
    const instructions = 'Review only the assigned files.';
    const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, systemPromptAppend: instructions });
    const extensions = await f.opened[0]!.services.extensions.bind({
      sessionManager: binding.runtime.session.sessionManager, rootSessionId: binding.rootSessionId,
    } as SessionExtensionContext);
    const extension = extensions.inlineExtensions!.find(item => item.name === '@felan-ai/daemon/child-instructions')!;
    const on = vi.fn();
    await extension.factory({ on } as unknown as ExtensionAPI);
    expect(on).toHaveBeenCalledOnce();
    expect(on.mock.calls[0]![0]).toBe('before_agent_start');
    const event = { systemPrompt: 'Base prompt', ...(systemPromptOptions ? { systemPromptOptions } : {}) };
    const result = await on.mock.calls[0]![1](event);
    if (systemPromptOptions?.sections) {
      expect(result).toBeUndefined();
      expect(systemPromptOptions.sections).toEqual({ session_tasks: 'Task context', child_instructions: instructions });
    } else {
      expect(result).toEqual({ systemPrompt: `Base prompt\n\n${instructions}` });
    }
    expect(event.systemPrompt).toBe('Base prompt');
  });

  it('persists a new header without replacing its prepared runtime and appends the first turn once', async () => {
    const f = await fixture();
    const open = vi.mocked(f.profile.openSession).getMockImplementation()!;
    vi.mocked(f.profile.openSession).mockImplementation(async request => {
      const binding = await open(request);
      binding.runtime.session.sessionManager.appendModelChange('offline', 'fixture');
      return binding;
    });
    const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    expect(f.profile.openSession).toHaveBeenCalledOnce();
    expect(f.instances.get(binding.sessionId)!.dispose).not.toHaveBeenCalled();
    const manager = binding.runtime.session.sessionManager;
    const entries = () => readFile(manager.getSessionFile()!, 'utf8').then(text => text.trim().split('\n').map(line => JSON.parse(line)));
    expect(await entries()).toEqual([manager.getHeader(), ...manager.getEntries()]);
    await binding.runtime.session.prompt('first turn');
    expect(await entries()).toEqual([manager.getHeader(), ...manager.getEntries()]);
    expect(manager.getEntries().map(entry => entry.type)).toEqual(['model_change', 'message', 'message']);
  });

  it('detach changes only attachment metadata, not runtime or services', async () => {
    const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const service = { busy: () => false, settle: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    f.registry.registerService(binding.sessionId, service);
    const first = await f.registry.attach(binding.sessionId, { principal: 'one', kind: 'tui' });
    const second = await f.registry.attach(binding.sessionId, { principal: 'two', kind: 'acp' });
    f.registry.detach(binding.sessionId, first.attachment); f.registry.detach(binding.sessionId, second.attachment);
    expect(f.registry.attachmentCount(binding.sessionId)).toBe(0);
    expect(await f.registry.evictIdle()).toEqual([]);
    expect(f.instances.get(binding.sessionId)!.abort).not.toHaveBeenCalled();
    expect(service.dispose).not.toHaveBeenCalled();
    await f.registry.close(binding.sessionId);
    expect(service.settle).toHaveBeenCalledOnce(); expect(service.dispose).toHaveBeenCalledOnce();
    expect(f.store.session(binding.sessionId).state).toBe('closed');
  });

  it('evicts only idle runtimes and restores actual Pi ID, cwd and branch without replay', async () => {
    const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    await binding.runtime.session.prompt('historic command is data');
    f.registry.projection(binding.sessionId).refresh();
    const before = f.store.session(binding.sessionId); const bytes = await readFile(before.piPath);
    expect(await f.registry.evictIdle()).toEqual([binding.sessionId]);
    const [a, b] = await Promise.all([f.registry.restore(binding.sessionId), f.registry.restore(binding.sessionId)]);
    expect(a).toBe(b); expect(a.sessionId).toBe(binding.sessionId); expect(a.agentRuntime).toBeDefined();
    expect(a.resources.cwd).toBe(f.cwd); expect(f.store.session(a.sessionId).branch).toBe(before.branch);
    expect(await readFile(before.piPath)).toEqual(bytes); expect(f.opened).toHaveLength(2);
  });

  it('previews the first user message from a live runtime or an evicted transcript', async () => {
    const f = await fixture();
    const live = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    expect(await f.registry.preview(f.store.session(live.sessionId))).toBe('');
    await live.runtime.session.prompt('first\n\tquestion'); await live.runtime.session.prompt('second');
    expect(await f.registry.preview(f.store.session(live.sessionId))).toBe('first question');
    const stored = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    await stored.runtime.session.prompt('from the transcript file');
    expect(await f.registry.evictIdle()).toEqual([live.sessionId, stored.sessionId]);
    expect(f.registry.binding(stored.sessionId)).toBeUndefined();
    expect(await f.registry.preview(f.store.session(stored.sessionId))).toBe('from the transcript file');
  });

  it('retains active runs and queued turns with zero attachments; cancel does not close', async () => {
    const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const id = binding.sessionId; const request = requestId();
    f.store.admit({ v: 1, id: request, op: 'prompt', session: id, params: { text: 'work' } }, 'owner');
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); f.releases.add(release);
    const work = f.registry.runAdmitted(request, id, { kind: 'tui', attachment: 'a' }, async () => { await gate; });
    expect(f.store.snapshot().requests[0]!.phase).toBe('dispatch_intent');
    expect(await f.registry.evictIdle()).toEqual([]);
    const cancelling = f.registry.cancel(id);
    await vi.waitFor(() => expect(f.instances.get(id)!.abort).toHaveBeenCalled());
    expect(f.store.session(id).run.state).toBe('cancelling');
    expect(await f.registry.evictIdle()).toEqual([]);
    release(); await Promise.all([work, cancelling]); expect(f.store.session(id).state).toBe('open');
    const queue = f.instances.get(id)!.queue; queue.followUp.push('not yet consumed');
    expect(await f.registry.evictIdle()).toEqual([]);
    queue.followUp.length = 0;
    expect(await f.registry.evictIdle()).toEqual([id]);
    expect(JSON.stringify(f.store.snapshot())).not.toContain('not yet consumed');
  });

  it('never evicts live PTY or detached-job references; these do not block policy changes', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    for (const kind of ['pty', 'detached'] as const) {
      f.store.putResource({ id: kind, session: b.sessionId, root: b.sessionId, kind, state: 'running', updatedAt: now });
      expect(await f.registry.evictIdle()).toEqual([]);
    }
    f.registry.tightenPolicy(b.sessionId);
    expect(f.store.session(b.sessionId).policy.effective).toBe('acp-strict');
  });

  it('holds nondeferred interaction runtime, allows deferred waits to survive eviction', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    f.store.putInteraction({ id: 'ask', scope: { kind: 'session', session: b.sessionId, root: b.sessionId }, request: { kind: 'input', title: 'Continue?' }, deferrable: true, state: 'waiting', createdAt: now });
    expect(await f.registry.evictIdle()).toEqual([]);
    f.store.deferInteraction('ask'); expect(await f.registry.evictIdle()).toEqual([b.sessionId]);
    await f.registry.restore(b.sessionId);
    expect(f.registry.projection(b.sessionId).snapshot().interactions[0]!.state).toBe('deferred');
  });

  it('shutdown disposes runtimes and listeners but does not close sessions or release external ownership', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    await f.registry.shutdown();
    expect(f.instances.get(b.sessionId)!.listeners.size).toBe(0);
    expect(f.store.session(b.sessionId)).toMatchObject({ state: 'open', residency: 'evicted' });
    expect(() => f.owner.assertCurrent()).not.toThrow();
    f.store.close(); const nextStore = new DaemonControlStore(f.owner, { now: () => now });
    const next = f.createRegistry(nextStore); f.replaceRegistry(next, nextStore);
    expect(next.recovery).toBeDefined();
    await next.restore(b.sessionId); expect(f.opened).toHaveLength(2);
  });
  it('restores the transcript tip after eviction, even if an older branch was selected, and refuses duplicate dispatched work', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    await b.runtime.session.prompt('first'); const selected = b.runtime.session.sessionManager.getLeafId()!;
    await b.runtime.session.prompt('second'); const tip = b.runtime.session.sessionManager.getLeafId()!;
    b.runtime.session.sessionManager.branch(selected);
    f.registry.projection(b.sessionId).refresh();
    await f.registry.evictIdle(); await f.registry.restore(b.sessionId);
    expect(f.registry.binding(b.sessionId)!.runtime.session.sessionManager.getLeafId()).toBe(tip);
    const id = requestId(); f.store.admit({ v: 1, id, op: 'prompt', session: b.sessionId, params: { text: 'once' } }, 'owner');
    const effect = vi.fn(async () => {});
    await f.registry.runAdmitted(id, b.sessionId, { kind: 'tui', attachment: 'one' }, effect);
    await expect(f.registry.runAdmitted(id, b.sessionId, { kind: 'tui', attachment: 'one' }, effect)).rejects.toThrow('never dispatch');
    expect(effect).toHaveBeenCalledOnce();
  });

  it('restores at the last transcript entry when work was appended on an older branch', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    await b.runtime.session.prompt('first'); const selected = b.runtime.session.sessionManager.getLeafId()!;
    await b.runtime.session.prompt('abandoned'); b.runtime.session.sessionManager.branch(selected);
    await b.runtime.session.prompt('continued on older branch'); const tip = b.runtime.session.sessionManager.getLeafId()!;
    await f.registry.evictIdle(); await expect(f.registry.restore(b.sessionId)).resolves.toBeDefined();
    expect(f.registry.binding(b.sessionId)!.runtime.session.sessionManager.getLeafId()).toBe(tip);
  });

  it('serializes attachment behind an in-flight eviction instead of exposing its disposed binding', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); f.releases.add(release);
    f.instances.get(b.sessionId)!.dispose.mockImplementationOnce(() => gate);
    const eviction = f.registry.evictIdle();
    let attached = false;
    const attachment = f.registry.attach(b.sessionId, { principal: 'late', kind: 'tui' }).then(value => { attached = true; return value; });
    await Promise.resolve(); expect(attached).toBe(false);
    release(); await eviction; await attachment;
    expect(f.registry.binding(b.sessionId)).not.toBe(b);
    expect(f.registry.attachmentCount(b.sessionId)).toBe(1);
  });

  it('reports lost queue state after recovery without reconstructing executable input', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    f.store.project(b.sessionId, [{ type: 'queue', ids: ['lost'], identity: { sha256: '0'.repeat(64), bytes: 9 } }]);
    await f.registry.shutdown(); f.store.close();
    const store = new DaemonControlStore(f.owner, { now: () => now }); const registry = f.createRegistry(store); f.replaceRegistry(registry, store);
    await registry.restore(b.sessionId);
    expect(registry.projection(b.sessionId).snapshot()).toMatchObject({ queue: [], presentation: [expect.objectContaining({ id: 'interrupted-queue', level: 'warning' })] });
    expect(f.opened.at(-1)!.target.kind).toBe('resume');
  });

  it('commits close intent across an already-started idle eviction', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const gate = deferred(); f.releases.add(gate.resolve);
    f.instances.get(b.sessionId)!.dispose.mockImplementationOnce(() => gate.promise);
    const eviction = f.registry.evictIdle(); const closing = f.registry.close(b.sessionId);
    expect(() => f.registry.restore(b.sessionId)).toThrow('closing');
    gate.resolve(); await Promise.all([eviction, closing]);
    expect(f.store.session(b.sessionId)).toMatchObject({ state: 'closed', residency: 'evicted' });
  });

  it('coalesces complete close operations including service cleanup and their errors', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const gate = deferred(); f.releases.add(gate.resolve);
    const service = { busy: () => false, settle: vi.fn(() => gate.promise), dispose: vi.fn(async () => {}) };
    f.registry.registerService(b.sessionId, service);
    const first = f.registry.close(b.sessionId); const second = f.registry.close(b.sessionId);
    expect(second).toBe(first); gate.resolve(); await Promise.all([first, second]);
    expect(service.settle).toHaveBeenCalledOnce(); expect(service.dispose).toHaveBeenCalledOnce();
  });

  it('restores real finalized context and active tools at the transcript tip after navigation', async () => {
    const f = await realFixture(); const session = f.root.runtime.session;
    const tools = session.getActiveToolNames();
    await session.prompt('first-only'); const selected = session.sessionManager.getLeafId()!;
    session.setActiveToolsByName([]); await session.prompt('second-included');
    const tip = session.sessionManager.getLeafId()!;
    await session.navigateTree(selected, { summarize: false });
    f.registry.projection(f.root.sessionId).refresh(); await f.registry.evictIdle();
    const restored = await f.registry.restore(f.root.sessionId);
    expect(restored.runtime.session.sessionManager.getLeafId()).toBe(tip);
    expect(JSON.stringify(restored.runtime.session.messages)).toContain('second-included');
    expect(restored.runtime.session.getActiveToolNames()).toEqual(tools);
  });

  it('fenced writer settlement waits for effects that outlive session abort', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const gate = deferred(); f.releases.add(gate.resolve); const id = requestId();
    f.store.admit({ v: 1, id, op: 'prompt', session: b.sessionId, params: { text: 'work' } }, 'owner');
    const work = f.registry.runAdmitted(id, b.sessionId, { kind: 'headless', attachment: 'fixture' }, () => gate.promise);
    const fault = f.registry as unknown as { fence(error: Error): void; failure?: unknown; failureSettlement?: Promise<void> };
    fault.fence(new Error('synthetic fence'));
    let settled = false; const barrier = f.registry.settleWriters().then(() => { settled = true; });
    await vi.waitFor(() => expect(f.instances.get(b.sessionId)!.abort).toHaveBeenCalled());
    expect(settled).toBe(false); gate.resolve(); await Promise.all([work, barrier]);
    delete fault.failure; delete fault.failureSettlement;
  });

  it('retains service settlement errors instead of proving a false fenced barrier', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const unregister = f.registry.registerService(b.sessionId, { busy: () => true, settle: async () => { throw new Error('still writing'); }, dispose: async () => {} });
    const fault = f.registry as unknown as { fence(error: Error): void; failure?: unknown; failureSettlement?: Promise<void> };
    fault.fence(new Error('synthetic fence'));
    await expect(f.registry.settleWriters()).rejects.toThrow('ownership must remain held');
    await expect(f.registry.settleWriters()).rejects.toThrow('ownership must remain held');
    unregister(); delete fault.failure; delete fault.failureSettlement;
  });

  it('joins pending opening cleanup before a fenced barrier can reject', async () => {
    const f = await fixture(); const gate = deferred(); const entered = deferred(); f.releases.add(gate.resolve);
    const open = vi.mocked(f.profile.openSession).getMockImplementation()!;
    vi.spyOn(f.profile, 'openSession').mockImplementation(async request => { const binding = await open(request); entered.resolve(); await gate.promise; return binding; });
    const creating = f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const rejected = expect(creating).rejects.toThrow('not admitting');
    await entered.promise;
    const fault = f.registry as unknown as { fence(error: Error): void; failure?: unknown; failureSettlement?: Promise<void> };
    fault.fence(new Error('synthetic fence'));
    let finished = false; const barrier = f.registry.settleWriters().catch(error => { finished = true; return error; });
    await Promise.resolve(); expect(finished).toBe(false);
    gate.resolve(); await rejected; expect(await barrier).toBeInstanceOf(AggregateError);
    expect([...f.instances.values()].every(instance => instance.dispose.mock.calls.length > 0)).toBe(true);
    delete fault.failure; delete fault.failureSettlement;
  });

  it('cancels an admitted run and projects Pi entries appended during it', async () => {
    const f = await fixture();
    const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const gate = deferred(); f.releases.add(gate.resolve); const id = requestId();
    const events: Array<{ state: string; revision: number }> = []; const completed: string[] = [];
    f.registry.subscribe(b.sessionId, event => {
      if (!('change' in event)) return;
      if (hasChangeType(event.change, 'run.updated')) {
        expect(f.store.session(b.sessionId).run).toEqual(event.change.run);
        expect(f.store.session(b.sessionId).revision).toBe(event.rev);
        events.push({ state: event.change.run.state, revision: event.rev });
      }
      if (hasChangeType(event.change, 'message.completed')) completed.push(event.change.message.id);
    });
    f.store.admit({ v: 1, id, op: 'prompt', session: b.sessionId, params: { text: 'work' } }, 'owner');
    const work = f.registry.runAdmitted(id, b.sessionId, { kind: 'headless', attachment: 'fixture' }, () => gate.promise);
    const cancelId = requestId(); f.store.admit({ v: 1, id: cancelId, op: 'cancel', session: b.sessionId, params: {} }, 'owner'); f.store.markDispatched(cancelId);
    const manager = b.runtime.session.sessionManager;
    manager.appendMessage({ role: 'user', content: 'only in Pi', timestamp: now }); manager.appendMessage(assistant());
    f.registry.projection(b.sessionId).refresh();
    expect(completed).toHaveLength(2);
    const fake = f.instances.get(b.sessionId)!; const abort = vi.mocked(b.runtime.session.abort).getMockImplementation()!;
    fake.abort.mockImplementationOnce(async () => { expect(f.store.session(b.sessionId).run.state).toBe('cancelling'); await abort(); });
    const cancel = f.registry.cancel(b.sessionId);
    await vi.waitFor(() => expect(fake.abort).toHaveBeenCalled());
    expect(f.store.session(b.sessionId).run.state).toBe('cancelling');
    expect(events.map(event => event.state)).toEqual(['idle', 'running', 'cancelling']);
    expect(events.every((event, index) => index === 0 || event.revision > events[index - 1]!.revision)).toBe(true);
    gate.resolve(); await Promise.all([work, cancel]);
    expect(events.map(event => event.state)).toEqual(['idle', 'running', 'cancelling', 'idle']);
    expect(events.every((event, index) => index === 0 || event.revision > events[index - 1]!.revision)).toBe(true);
    for (const request of [id, cancelId]) f.store.finishRequest(request, { v: 1, re: request, outcome: 'accepted', result: request === id ? { runId: 'accepted' } : {} });
    await vi.waitFor(() => expect(completed).toHaveLength(2));
    expect(new Set(completed).size).toBe(2);
    expect(f.store.session(b.sessionId).projections.filter(row => row.value.type === 'message')).toHaveLength(2);
    expect(fake.abort).toHaveBeenCalledOnce();
  });

  it('settles runtime agent_settled and admitted finalization without cancelling', async () => {
    const f = await fixture();
    const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const request = requestId(); f.store.admit({ v: 1, id: request, op: 'prompt', session: b.sessionId, params: { text: 'runtime' } }, 'owner'); f.store.markDispatched(request);
    const fake = f.instances.get(b.sessionId)!;
    const stop = fake.session.subscribe(event => {
      if (event.type === 'agent_start') {
        const id = requestId(); f.store.admit({ v: 1, id, op: 'cancel', session: b.sessionId, params: {} }, 'owner'); f.store.markDispatched(id);
      }
    });
    await fake.session.prompt('runtime'); stop();
    expect(f.store.session(b.sessionId).run.state).toBe('idle');
    expect(f.store.snapshot().requests.every(row => row.phase === 'dispatch_intent')).toBe(true);
    for (const row of f.store.snapshot().requests) f.store.finishRequest(row.id, { v: 1, re: row.id, outcome: 'rejected', error: { code: 'unavailable', message: 'done', retryable: true } });
    await vi.waitFor(() => expect(f.store.session(b.sessionId).projections.filter(row => row.value.type === 'message')).toHaveLength(2));
    const id = requestId(); f.store.admit({ v: 1, id, op: 'prompt', session: b.sessionId, params: { text: 'admitted' } }, 'owner');
    await f.registry.runAdmitted(id, b.sessionId, { kind: 'headless', attachment: 'fixture' }, async () => {
      const cancel = requestId(); f.store.admit({ v: 1, id: cancel, op: 'cancel', session: b.sessionId, params: {} }, 'owner'); f.store.markDispatched(cancel);
    });
    expect(f.store.session(b.sessionId).run.state).toBe('idle');
  });

  it('does not apply an old admitted finalizer to a newer run ID', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const gate = deferred(); f.releases.add(gate.resolve); const id = requestId();
    f.store.admit({ v: 1, id, op: 'prompt', session: b.sessionId, params: { text: 'old' } }, 'owner');
    const old = f.registry.runAdmitted(id, b.sessionId, { kind: 'headless', attachment: 'fixture' }, () => gate.promise);
    f.store.updateSession(b.sessionId, { run: { state: 'running', id: 'newer' } });
    gate.resolve(); await old;
    f.registry.projection(b.sessionId).settleRun(undefined);
    expect(f.store.session(b.sessionId).run).toEqual({ state: 'running', id: 'newer' });
  });

  it('closes, evicts and drains separate sessions', async () => {
    const f = await fixture();
    const sessions = [];
    for (let i = 0; i < 4; i++) sessions.push(await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } }));
    const [closed, evicted, other, drained] = sessions;
    await f.registry.attach(drained!.sessionId, { principal: 'fixture', kind: 'tui' });
    const id = requestId(); f.store.admit({ v: 1, id, op: 'prompt', session: closed!.sessionId, params: { text: 'reserved only' } }, 'owner');
    const cancel = requestId(); f.store.admit({ v: 1, id: cancel, op: 'cancel', session: closed!.sessionId, params: {} }, 'owner'); f.store.markDispatched(cancel);
    const retained = f.store.snapshot().requests;
    await f.registry.close(closed!.sessionId);
    expect(await f.registry.evictIdle()).toEqual([evicted!.sessionId, other!.sessionId]);
    await f.registry.shutdown();
    expect(f.store.session(closed!.sessionId)).toMatchObject({ state: 'closed', residency: 'evicted' });
    for (const session of sessions.slice(1)) expect(f.store.session(session.sessionId)).toMatchObject({ state: 'open', residency: 'evicted' });
    expect(f.store.snapshot().requests).toEqual(retained);
  });

  it('does not defer storage, ownership or validation failures as projection capacity pressure', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    for (const code of ['storage_failure', 'ownership_lost', 'invalid_request', 'request_capacity'] as const) {
      b.runtime.session.sessionManager.appendMessage(assistant(code));
      const spy = vi.spyOn(f.store, 'project').mockImplementationOnce(() => { throw new ControlStoreError(code, 'not transient capacity'); });
      expect(() => f.registry.projection(b.sessionId).refresh()).toThrow('not transient capacity');
      spy.mockRestore(); f.registry.projection(b.sessionId).refresh();
    }
    expect(f.store.session(b.sessionId).projections.filter(row => row.value.type === 'message')).toHaveLength(4);
  });

  for (const fenced of [false, true]) {
    it(`joins held cancellation before the ${fenced ? 'fenced' : 'ordinary'} writer barrier returns`, async () => {
      const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
      f.store.updateSession(b.sessionId, { run: { state: 'running', id: 'held' } });
      const gate = deferred(); const secondAbort = deferred(); f.releases.add(gate.resolve);
      const fake = f.instances.get(b.sessionId)!; const original = vi.mocked(b.runtime.session.abort).getMockImplementation()!;
      fake.abort.mockImplementation(async () => { await original(); secondAbort.resolve(); });
      fake.abort.mockImplementationOnce(async () => { await gate.promise; await original(); });
      let cancelled = false;
      const cancel = f.registry.cancel(b.sessionId).then(() => { cancelled = true; });
      await vi.waitFor(() => expect(fake.abort).toHaveBeenCalledOnce());
      const fault = f.registry as unknown as { fence(error: Error): void; failure?: unknown; failureSettlement?: Promise<void> };
      if (fenced) fault.fence(new Error('fence during cancellation'));
      let returned = false;
      const barrier = f.registry.settleWriters().then(() => { returned = true; return { cancelled, revision: f.store.session(b.sessionId).revision }; });
      if (fenced) await secondAbort.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(returned).toBe(false);
      gate.resolve(); const [, snapshot] = await Promise.all([cancel, barrier]);
      expect(snapshot.cancelled).toBe(true);
      expect(f.store.session(b.sessionId).revision).toBe(snapshot.revision);
      if (fenced) await expect(f.registry.cancel(b.sessionId)).rejects.toThrow('not admitting');
      expect(f.store.session(b.sessionId).revision).toBe(snapshot.revision);
      delete fault.failure; delete fault.failureSettlement;
    });
  }

  it('retains a cancellation rejection after the fenced continuation has finished', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    f.store.updateSession(b.sessionId, { run: { state: 'running', id: 'rejected' } });
    const gate = deferred(); f.releases.add(gate.resolve);
    f.instances.get(b.sessionId)!.abort.mockImplementationOnce(async () => { await gate.promise; throw new Error('cancel cleanup failed'); });
    const cancel = f.registry.cancel(b.sessionId).then(() => undefined, error => error);
    await vi.waitFor(() => expect(f.instances.get(b.sessionId)!.abort).toHaveBeenCalledOnce());
    const fault = f.registry as unknown as { fence(error: Error): void; failure?: unknown; failureSettlement?: Promise<void> };
    fault.fence(new Error('fenced cancellation'));
    const barrier = f.registry.settleWriters().then(() => undefined, error => error);
    gate.resolve(); expect(await cancel).toMatchObject({ message: 'cancel cleanup failed' });
    expect(await barrier).toBeInstanceOf(AggregateError);
    const revision = f.store.session(b.sessionId).revision;
    await expect(f.registry.settleWriters()).rejects.toThrow('ownership must remain held');
    expect(f.store.session(b.sessionId).revision).toBe(revision);
    delete fault.failure; delete fault.failureSettlement;
    await expect(f.registry.settleWriters()).rejects.toThrow('ownership must remain held');
  });

});
