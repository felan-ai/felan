import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlStoreError } from '../src/daemon/control-state.js';
import { PROJECTION_CLEANUP_LIMIT_MS, type RegistryOpenRequest } from '../src/daemon/registry.js';
import { assistant, deferred, fixture, fixtures, requestId, supported } from './fixtures/registry.js';

afterEach(async () => { for (const cleanup of fixtures.splice(0)) await cleanup(); });

describe.skipIf(!supported)('session-local projection failure', () => {
  it('evicts an idle projection failure and restores it on attach without poisoning drain', async () => {
    const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const id = binding.sessionId; const runtime = f.instances.get(id)!;
    const failure = new Error('idle projection failure');
    const diagnostic = vi.fn(); f.registry.options.onDiagnostic = diagnostic;
    const observed = vi.fn(); f.registry.subscribe(id, observed);
    const getBranch = vi.spyOn(runtime.session.sessionManager, 'getBranch').mockImplementation(() => { throw failure; });
    runtime.session.sessionManager.appendMessage(assistant());
    runtime.emit({ type: 'message_start', message: assistant() });
    await f.registry.settleWriters();
    expect(diagnostic.mock.calls).toEqual([[{ scope: 'projection', session: id, error: failure }]]);
    expect(f.store.session(id)).toMatchObject({ state: 'open', residency: 'evicted', run: { state: 'idle' } });
    expect(f.registry.binding(id)).toBeUndefined();
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({ change: { type: 'metadata.updated', title: '', state: 'open', residency: 'evicted' } }));
    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(f.registry.fenced).toBe(false);
    f.registry.beginDrain();
    await f.registry.waitForDrain();
    f.registry.endDrain();
    getBranch.mockRestore();
    await f.registry.attach(id, { principal: 'fixture', kind: 'headless' });
    const reopened = f.registry.binding(id)!;
    expect(reopened).not.toBe(binding);
    await reopened.runtime.session.prompt('works after reopening');
    await f.registry.settleWriters();
    expect(f.registry.projection(id).snapshot().run.state).toBe('idle');
  });

  it('lets an in-flight close finish its cleanup before disposing the failed entry', async () => {
    const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const id = binding.sessionId; const runtime = f.instances.get(id)!;
    const closingAbort = deferred(); f.releases.add(closingAbort.resolve);
    runtime.abort.mockImplementationOnce(() => closingAbort.promise);
    const getBranch = vi.spyOn(runtime.session.sessionManager, 'getBranch').mockImplementation(() => { throw new Error('failed while closing'); });
    runtime.session.sessionManager.appendMessage(assistant());
    runtime.emit({ type: 'message_start', message: assistant() });
    const closing = f.registry.close(id);
    void closing.catch(() => {});
    await vi.waitFor(() => expect(runtime.abort).toHaveBeenCalledOnce());
    expect(f.registry.binding(id)).toBe(binding);
    expect(runtime.dispose).not.toHaveBeenCalled();
    closingAbort.resolve(); await closing; await f.registry.settleWriters();
    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(f.registry.binding(id)).toBeUndefined();
    expect(f.store.session(id)).toMatchObject({ state: 'closed', residency: 'evicted' });
    await expect(f.registry.close(id)).resolves.toBeUndefined();
    getBranch.mockRestore();
  });

  it.each(['subscription', 'timer'] as const)('aborts an active turn after a %s failure without retrying projection or resuming queued work', async source => {
    const f = await fixture();
    const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const other = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const id = binding.sessionId;
    const runtime = f.instances.get(id)!;
    const started = deferred(); const stopped = deferred(); const cleanupAllowed = deferred();
    f.releases.add(cleanupAllowed.resolve);
    let active = false;
    Object.defineProperty(runtime.session, 'isIdle', { get: () => !active });
    const prompt = runtime.session.prompt.bind(runtime.session);
    vi.spyOn(runtime.session, 'prompt').mockImplementation(async text => {
      await prompt(text);
      active = true; started.resolve();
      await stopped.promise;
      active = false;
    });
    const foregroundStarted = deferred();
    runtime.abort.mockImplementation(async () => { await foregroundStarted.promise; await cleanupAllowed.promise; active = false; stopped.resolve(); });
    const cancelForeground = vi.spyOn(f.registry.processes, 'cancelForeground').mockImplementation(async () => { foregroundStarted.resolve(); });
    const resume = vi.spyOn(f.registry.executionHost(id), 'resumeQueued');
    const diagnostic = vi.fn(); f.registry.options.onDiagnostic = diagnostic;
    const attached = await f.registry.attach(id, { principal: 'fixture', kind: 'headless' });
    const observed: string[] = [];
    const unsubscribe = f.registry.subscribe(id, event => {
      if ('change' in event && event.change.type === 'run.updated') observed.push(event.change.run.state);
    });
    const request = requestId();
    f.store.admit({ v: 1, id: request, op: 'prompt', session: id, params: { text: 'keep canonical data' } }, 'fixture');
    const run = f.registry.runAdmitted(request, id, { kind: 'headless', attachment: 'fixture' }, session => session.prompt('keep canonical data'));
    await started.promise;
    runtime.queue.followUp.push('must not resume');
    const clearQueue = vi.spyOn(runtime.session, 'clearQueue');
    const projection = f.registry.projection(id);
    const presentations = vi.spyOn(projection, 'presentations').mockImplementation(() => { throw new Error('must not consult the broken projection during cleanup'); });
    const failure = new Error(`original ${source} projection failure`);
    const getBranch = source === 'subscription'
      ? vi.spyOn(runtime.session.sessionManager, 'getBranch').mockImplementation(() => { throw failure; })
      : undefined;
    const getName = source === 'timer'
      ? vi.spyOn(runtime.session.sessionManager, 'getSessionName').mockImplementation(() => { throw failure; })
      : undefined;
    const refresh = vi.spyOn(projection, 'refresh');
    if (source === 'subscription') runtime.session.sessionManager.appendMessage(assistant('unprojected'));
    runtime.emit(source === 'subscription' ? { type: 'message_start', message: assistant() } : { type: 'compaction_start', automatic: false });
    await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledWith({ scope: 'projection', session: id, error: failure }));
    const refreshes = refresh.mock.calls.length;
    expect(() => f.registry.assertDispatch(id)).toThrow('Session projection failed; it reopens once cleanup finishes, try again shortly.');
    expect(() => f.registry.assertServiceAccess(id)).toThrow('Session projection failed; it reopens once cleanup finishes, try again shortly.');
    await expect(f.registry.attach(id, { principal: 'fixture', kind: 'headless' })).rejects.toMatchObject({ code: 'unavailable' });
    const cancellation = f.registry.cancel(id);
    cleanupAllowed.resolve();
    await run;
    await cancellation;
    await f.registry.settleWriters();
    expect(runtime.abort).toHaveBeenCalledTimes(1);
    expect(cancelForeground).toHaveBeenCalledWith(id);
    expect(clearQueue).toHaveBeenCalledTimes(1);
    expect(runtime.queue.followUp).toEqual([]);
    expect(resume).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(refreshes);
    expect(presentations).not.toHaveBeenCalled();
    expect(f.store.session(id)).toMatchObject({ state: 'open', residency: 'evicted', run: { state: 'idle' } });
    expect(f.registry.binding(id)).toBeUndefined();
    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(await f.registry.activeWork()).toBe(0);
    expect(observed.slice(-2)).toEqual(['cancelling', 'idle']);
    expect(runtime.abort).toHaveBeenCalledTimes(1);
    expect(f.registry.fenced).toBe(false);
    expect(runtime.session.sessionManager.getEntries()).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.objectContaining({ role: 'user', content: 'keep canonical data' }) }),
    ]));
    await other.runtime.session.prompt('unrelated session still works');
    expect(f.registry.projection(other.sessionId).snapshot().history.entries).toHaveLength(2);
    getBranch?.mockRestore(); getName?.mockRestore();
    unsubscribe(); f.registry.detach(id, attached.attachment);
    const restored = await f.registry.restore(id);
    expect(restored).not.toBe(binding);
    expect(f.registry.projection(id)).not.toBe(projection);
    const next = requestId();
    f.store.admit({ v: 1, id: next, op: 'prompt', session: id, params: { text: 'works after eviction' } }, 'fixture');
    await f.registry.runAdmitted(next, id, { kind: 'headless', attachment: 'fixture' }, session => session.prompt('works after eviction'));
    expect(f.registry.projection(id).snapshot().run.state).toBe('idle');
    expect(restored.runtime.session.sessionManager.getEntries()).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.objectContaining({ role: 'user', content: 'keep canonical data' }) }),
      expect.objectContaining({ message: expect.objectContaining({ role: 'user', content: 'works after eviction' }) }),
    ]));
    expect(refresh).toHaveBeenCalledTimes(refreshes);
  });

  it('evicts a failed root with pending host work without evicting its healthy child', async () => {
    const f = await fixture(); const root = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const id = root.sessionId; const runtime = f.instances.get(id)!;
    const child = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, parentSessionId: id, rootSessionId: id,
      execution: { request: { description: 'queued child', prompt: 'wait for the parent', notifyOnCompletion: false }, createdAt: new Date().toISOString(), deliveryId: 'queued', completionPending: false } });
    const host = f.registry.executionHost(id); const shutdown = vi.spyOn(host, 'shutdown');
    const service = { disposeWhenIdle: true, busy: () => true, settle: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    f.registry.registerService(id, service);
    expect(host.hasPendingWork()).toBe(true);
    expect(await f.registry.activeWork()).toBeGreaterThan(0);
    expect(await f.registry.evictIdle()).toEqual([]);
    const getBranch = vi.spyOn(runtime.session.sessionManager, 'getBranch').mockImplementation(() => { throw new Error('failed root'); });
    runtime.session.sessionManager.appendMessage(assistant());
    runtime.emit({ type: 'message_start', message: assistant() });
    await f.registry.settleWriters();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(service.settle).toHaveBeenCalledWith('drain');
    expect(service.dispose).toHaveBeenCalledOnce();
    expect(host.hasPendingWork()).toBe(false);
    expect(f.registry.binding(id)).toBeUndefined();
    expect(f.registry.binding(child.sessionId)).toBe(child);
    expect(f.store.session(id)).toMatchObject({ state: 'open', residency: 'evicted' });
    expect(f.store.session(child.sessionId)).toMatchObject({ state: 'open', residency: 'warm', execution: { outcome: 'cancelled' } });
    expect(await f.registry.activeWork()).toBe(0);
    getBranch.mockRestore();
    expect(await f.registry.evictIdle()).toEqual([child.sessionId]);
    expect(await f.registry.restore(id)).not.toBe(root);
  });

  it('bounds cleanup to the configured limit and holds its writer claim until late settlement', async () => {
    const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const id = binding.sessionId; const runtime = f.instances.get(id)!;
    const aborted = deferred(); const firstStarted = deferred(); const firstFinished = deferred();
    f.releases.add(aborted.resolve); f.releases.add(firstFinished.resolve);
    let active = false;
    Object.defineProperty(runtime.session, 'isIdle', { get: () => !active });
    runtime.abort.mockImplementation(() => aborted.promise);
    runtime.dispose.mockImplementation(async () => { active = false; });
    const first = requestId();
    f.store.admit({ v: 1, id: first, op: 'prompt', session: id, params: { text: 'old run' } }, 'fixture');
    const firstRun = f.registry.runAdmitted(first, id, { kind: 'headless', attachment: 'fixture' }, async session => {
      await session.prompt('old run'); active = true; firstStarted.resolve(); await firstFinished.promise; active = false;
    });
    await firstStarted.promise;
    const diagnostic = vi.fn(); f.registry.options.onDiagnostic = diagnostic;
    const getBranch = vi.spyOn(runtime.session.sessionManager, 'getBranch').mockImplementation(() => { throw new Error('stuck projection cleanup'); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      runtime.session.sessionManager.appendMessage(assistant());
      runtime.emit({ type: 'message_start', message: assistant() });
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.abort).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(PROJECTION_CLEANUP_LIMIT_MS - 1);
      expect(f.registry.binding(id)).toBe(binding);
      expect(f.store.session(id).run.state).toBe('cancelling');
      expect(runtime.dispose).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(f.registry.binding(id)).toBeUndefined();
      expect(f.store.session(id)).toMatchObject({ state: 'open', residency: 'evicted', run: { state: 'interrupted' } });
      expect(runtime.dispose).toHaveBeenCalledOnce();
      expect(f.registry.fenced).toBe(false);
      expect(await f.registry.activeWork()).toBe(1);
      expect(diagnostic).toHaveBeenCalledWith({ scope: 'registry', session: id, error: expect.objectContaining({ message: `Projection-failure cleanup timed out after ${PROJECTION_CLEANUP_LIMIT_MS} milliseconds.` }) });
      const fault = f.registry as unknown as { cancellationFailures: Set<unknown>; open(request: RegistryOpenRequest): Promise<unknown> };
      const timeout = expect.objectContaining({ message: `Projection-failure cleanup timed out after ${PROJECTION_CLEANUP_LIMIT_MS} milliseconds.` });
      expect([...fault.cancellationFailures]).toContainEqual(timeout);
      expect(() => f.registry.restore(id)).toThrow('Session transcript already has a writer.');
      await expect(f.registry.attach(id, { principal: 'fixture', kind: 'headless' })).rejects.toMatchObject({ code: 'busy' });
      await expect(fault.open({ cwd: f.cwd, target: { kind: 'resume', sessionFile: f.store.session(id).piPath } })).rejects.toThrow('Session transcript already has a live writer.');
      const reload = requestId();
      f.store.admit({ v: 1, id: reload, op: 'session.reload', session: id, params: {} }, 'fixture');
      expect(() => f.registry.reloadAdmitted(reload, id)).toThrow('Session transcript already has a writer.');
      let settled = false;
      const settling = f.registry.settleWriters().then(() => { settled = true; }); void settling.catch(() => {});
      aborted.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      expect([...fault.cancellationFailures]).toContainEqual(timeout);
      expect(() => f.registry.restore(id)).toThrow('Session transcript already has a writer.');
      firstFinished.resolve(); await firstRun; await settling;
      expect([...fault.cancellationFailures]).toEqual([]);
      expect(await f.registry.activeWork()).toBe(0);
    } finally { vi.useRealTimers(); getBranch.mockRestore(); }
    const restored = await f.registry.restore(id);
    expect(restored).not.toBe(binding);
    const next = requestId();
    f.store.admit({ v: 1, id: next, op: 'prompt', session: id, params: { text: 'new run' } }, 'fixture');
    await f.registry.runAdmitted(next, id, { kind: 'headless', attachment: 'fixture' }, session => session.prompt('new run'));
    expect(f.registry.projection(id).snapshot().run.state).toBe('idle');
    await expect(f.registry.settleWriters()).resolves.toBeUndefined();
  });

  it.each(['eviction', 'close'] as const)('publishes interruption before wedged %s disposal and tracks its settlement', async mode => {
    const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const id = binding.sessionId; const runtime = f.instances.get(id)!;
    const aborted = deferred(); const disposed = deferred(); const started = deferred(); const finished = deferred();
    for (const release of [aborted.resolve, disposed.resolve, finished.resolve]) f.releases.add(release);
    runtime.abort.mockImplementation(() => aborted.promise);
    runtime.dispose.mockImplementation(() => disposed.promise);
    const observed = vi.fn(); f.registry.subscribe(id, observed);
    const request = requestId();
    f.store.admit({ v: 1, id: request, op: 'prompt', session: id, params: { text: 'stuck' } }, 'fixture');
    const run = f.registry.runAdmitted(request, id, { kind: 'headless', attachment: 'fixture' }, async () => { started.resolve(); await finished.promise; });
    await started.promise;
    const getBranch = vi.spyOn(runtime.session.sessionManager, 'getBranch').mockImplementation(() => { throw new Error('wedged disposal'); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      runtime.session.sessionManager.appendMessage(assistant()); runtime.emit({ type: 'message_start', message: assistant() });
      const closing = mode === 'close' ? f.registry.close(id) : undefined;
      await vi.advanceTimersByTimeAsync(PROJECTION_CLEANUP_LIMIT_MS);
      expect(runtime.dispose).toHaveBeenCalledOnce();
      expect(f.registry.binding(id)).toBe(binding);
      expect(f.registry.list().filter(row => ['running', 'waiting', 'cancelling'].includes(row.run.state))).toHaveLength(0);
      expect(observed).toHaveBeenCalledWith(expect.objectContaining({ change: { type: 'run.updated', run: expect.objectContaining({ state: 'interrupted' }) } }));
      aborted.resolve(); finished.resolve(); await run; await new Promise<void>(resolve => setImmediate(resolve));
      const fault = f.registry as unknown as { cancellationFailures: Set<unknown> };
      expect([...fault.cancellationFailures]).toContainEqual(expect.objectContaining({ message: `Projection-failure cleanup timed out after ${PROJECTION_CLEANUP_LIMIT_MS} milliseconds.` }));
      expect(await f.registry.activeWork()).toBe(1);
      expect(() => f.registry.restore(id)).toThrow('Session transcript already has a writer.');
      await expect(f.registry.attach(id, { principal: 'fixture', kind: 'headless' })).rejects.toMatchObject({ code: 'busy' });
      let settled = false;
      const settling = f.registry.settleWriters().then(() => { settled = true; }); void settling.catch(() => {});
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      disposed.resolve(); await closing; await settling;
      expect([...fault.cancellationFailures]).toEqual([]);
      expect(observed).toHaveBeenCalledWith(expect.objectContaining({ change: { type: 'metadata.updated', title: '', state: mode === 'close' ? 'closed' : 'open', residency: 'evicted' } }));
    } finally { vi.useRealTimers(); getBranch.mockRestore(); }
  });

  it.each(['shutdown', 'fencing'] as const)('joins evicted late writers during %s', async mode => {
    const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const id = binding.sessionId; const runtime = f.instances.get(id)!;
    const aborted = deferred(); const started = deferred(); const finished = deferred();
    f.releases.add(aborted.resolve); f.releases.add(finished.resolve);
    runtime.abort.mockImplementation(() => aborted.promise);
    const request = requestId();
    f.store.admit({ v: 1, id: request, op: 'prompt', session: id, params: { text: 'late writer' } }, 'fixture');
    const run = f.registry.runAdmitted(request, id, { kind: 'headless', attachment: 'fixture' }, async () => { started.resolve(); await finished.promise; });
    await started.promise;
    const getBranch = vi.spyOn(runtime.session.sessionManager, 'getBranch').mockImplementation(() => { throw new Error('late writer projection'); });
    const fault = f.registry as unknown as { failure?: unknown; failureSettlement?: Promise<void> };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      runtime.session.sessionManager.appendMessage(assistant()); runtime.emit({ type: 'message_start', message: assistant() });
      await vi.advanceTimersByTimeAsync(PROJECTION_CLEANUP_LIMIT_MS);
      expect(f.registry.binding(id)).toBeUndefined();
      if (mode === 'fencing') f.registry.failExecution(new Error('ownership settlement test'));
      let settled = false;
      const settlement = (mode === 'shutdown' ? f.registry.shutdown() : f.registry.settleWriters()).then(() => { settled = true; });
      void settlement.catch(() => {});
      finished.resolve(); await run; await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      aborted.resolve(); await settlement;
      expect(settled).toBe(true);
    } finally { vi.useRealTimers(); getBranch.mockRestore(); delete fault.failure; delete fault.failureSettlement; }
  });

  it('closes during wedged projection cleanup without retrying abort or releasing the writer claim', async () => {
    const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const id = binding.sessionId; const runtime = f.instances.get(id)!;
    const aborted = deferred(); const started = deferred(); const finished = deferred();
    f.releases.add(aborted.resolve); f.releases.add(finished.resolve);
    runtime.abort.mockImplementation(() => aborted.promise);
    const observed = vi.fn(); f.registry.subscribe(id, observed);
    const request = requestId();
    f.store.admit({ v: 1, id: request, op: 'prompt', session: id, params: { text: 'closing writer' } }, 'fixture');
    const run = f.registry.runAdmitted(request, id, { kind: 'headless', attachment: 'fixture' }, async () => { started.resolve(); await finished.promise; });
    await started.promise;
    const getBranch = vi.spyOn(runtime.session.sessionManager, 'getBranch').mockImplementation(() => { throw new Error('failed before close'); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      runtime.session.sessionManager.appendMessage(assistant()); runtime.emit({ type: 'message_start', message: assistant() });
      const closing = f.registry.close(id);
      await vi.advanceTimersByTimeAsync(PROJECTION_CLEANUP_LIMIT_MS - 1);
      expect(f.registry.binding(id)).toBe(binding);
      await vi.advanceTimersByTimeAsync(1); await closing;
      expect(runtime.abort).toHaveBeenCalledOnce();
      expect(runtime.dispose).toHaveBeenCalledOnce();
      expect(f.registry.binding(id)).toBeUndefined();
      expect(f.store.session(id)).toMatchObject({ state: 'closed', residency: 'evicted', run: { state: 'idle' } });
      expect(observed).toHaveBeenCalledWith(expect.objectContaining({ change: { type: 'run.updated', run: expect.objectContaining({ state: 'interrupted' }) } }));
      expect(observed).toHaveBeenCalledWith(expect.objectContaining({ change: { type: 'metadata.updated', title: '', state: 'closed', residency: 'evicted' } }));
      expect(() => f.registry.restore(id)).toThrow('Session transcript already has a writer.');
      expect(f.store.session(id).state).toBe('closed');
      aborted.resolve(); finished.resolve(); await run; await f.registry.settleWriters();
    } finally { vi.useRealTimers(); getBranch.mockRestore(); }
    expect(await f.registry.restore(id)).not.toBe(binding);
  });

  it('leaves projection failure during stopping for shutdown to dispose', async () => {
    const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const id = binding.sessionId; const runtime = f.instances.get(id)!;
    const foreground = deferred(); f.releases.add(foreground.resolve);
    const cancelForeground = vi.spyOn(f.registry.processes, 'cancelForeground').mockImplementationOnce(() => foreground.promise);
    const shutdown = f.registry.shutdown();
    await vi.waitFor(() => expect(cancelForeground).toHaveBeenCalledOnce());
    const getBranch = vi.spyOn(runtime.session.sessionManager, 'getBranch').mockImplementation(() => { throw new Error('failed during shutdown'); });
    try {
      runtime.session.sessionManager.appendMessage(assistant()); runtime.emit({ type: 'message_start', message: assistant() });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(f.registry.binding(id)).toBe(binding);
      expect(runtime.dispose).not.toHaveBeenCalled();
    } finally { foreground.resolve(); await shutdown; getBranch.mockRestore(); }
    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(f.registry.binding(id)).toBeUndefined();
  });

  it.each(['cleanup', 'timer'] as const)('settles projection cancellation even if the %s failure reporter throws', async source => {
    const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const id = binding.sessionId; const runtime = f.instances.get(id)!;
    const aborted = deferred(); f.releases.add(aborted.resolve);
    if (source === 'timer') runtime.abort.mockImplementation(() => aborted.promise);
    else runtime.abort.mockRejectedValueOnce(new Error('abort failed'));
    const fault = f.registry as unknown as { projectionIntegrityIntact(error: unknown): boolean; cancellationFailures: Set<unknown> };
    const integrity = vi.spyOn(fault, 'projectionIntegrityIntact').mockImplementationOnce(() => true).mockImplementation(() => { throw new Error('failure reporter threw'); });
    const getBranch = vi.spyOn(runtime.session.sessionManager, 'getBranch').mockImplementation(() => { throw new Error('failed projection'); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      runtime.session.sessionManager.appendMessage(assistant()); runtime.emit({ type: 'message_start', message: assistant() });
      await vi.advanceTimersByTimeAsync(source === 'timer' ? PROJECTION_CLEANUP_LIMIT_MS : 0);
      expect(f.registry.binding(id)).toBeUndefined();
      expect(runtime.dispose).toHaveBeenCalledOnce();
      aborted.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
    } finally { vi.useRealTimers(); getBranch.mockRestore(); integrity.mockRestore(); fault.cancellationFailures.clear(); }
  });

  it('keeps waiting for writers when cleanup failure reporting throws', async () => {
    const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const id = binding.sessionId; const runtime = f.instances.get(id)!;
    const started = deferred(); const finished = deferred(); f.releases.add(finished.resolve);
    const request = requestId();
    f.store.admit({ v: 1, id: request, op: 'prompt', session: id, params: { text: 'pending writer' } }, 'fixture');
    const run = f.registry.runAdmitted(request, id, { kind: 'headless', attachment: 'fixture' }, async () => { started.resolve(); await finished.promise; });
    await started.promise;
    runtime.abort.mockRejectedValueOnce(new Error('abort failed'));
    const fault = f.registry as unknown as { projectionIntegrityIntact(error: unknown): boolean; cancellationFailures: Set<unknown> };
    const integrity = vi.spyOn(fault, 'projectionIntegrityIntact').mockImplementationOnce(() => true).mockImplementation(() => { throw new Error('failure reporter threw'); });
    const getBranch = vi.spyOn(runtime.session.sessionManager, 'getBranch').mockImplementation(() => { throw new Error('pending writer projection'); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      runtime.session.sessionManager.appendMessage(assistant()); runtime.emit({ type: 'message_start', message: assistant() });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.registry.binding(id)).toBe(binding);
      expect(runtime.dispose).not.toHaveBeenCalled();
      expect(await f.registry.activeWork()).toBe(1);
      finished.resolve(); await run;
      await expect(f.registry.settleWriters()).rejects.toThrow('writers did not settle cleanly');
      expect(f.registry.binding(id)).toBeUndefined();
    } finally { vi.useRealTimers(); getBranch.mockRestore(); integrity.mockRestore(); fault.cancellationFailures.clear(); }
  });

  it('keeps a turn with an oversized valid message running and clips only its projection', async () => {
    const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const id = binding.sessionId; const request = requestId();
    const text = 'x'.repeat(9_151_053);
    f.store.admit({ v: 1, id: request, op: 'prompt', session: id, params: { text: 'valid result' } }, 'fixture');
    await f.registry.runAdmitted(request, id, { kind: 'headless', attachment: 'fixture' }, async session => {
      await session.prompt('valid result');
      const entryId = session.sessionManager.appendMessage({ role: 'toolResult', toolCallId: 'large', toolName: 'test', isError: false,
        content: [{ type: 'text', text }], timestamp: 0 });
      f.registry.projection(id).refresh();
      expect(session.sessionManager.getEntry(entryId)).toMatchObject({ message: { content: [{ type: 'text', text }] } });
      expect(JSON.stringify(f.registry.projection(id).snapshot().history)).toContain('Clipped for display');
      expect(() => f.registry.assertDispatch(id)).not.toThrow();
    });
    expect(f.instances.get(id)!.abort).not.toHaveBeenCalled();
    expect(f.store.session(id).run.state).toBe('idle');
    expect(f.registry.fenced).toBe(false);
  });

  it('aborts pending run acquisition before its effect can dispatch', async () => {
    const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const acquired = deferred();
    let signal: AbortSignal | undefined;
    f.registry.options.acquireRun = async (_owner, pending) => {
      signal = pending; acquired.resolve();
      await new Promise<void>(resolve => pending.addEventListener('abort', () => resolve(), { once: true }));
      return () => {};
    };
    const id = binding.sessionId; const request = requestId();
    f.store.admit({ v: 1, id: request, op: 'prompt', session: id, params: { text: 'pending' } }, 'fixture');
    const effect = vi.fn(async () => {});
    const run = f.registry.runAdmitted(request, id, { kind: 'headless', attachment: 'fixture' }, effect);
    const rejected = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    await acquired.promise;
    const manager = binding.runtime.session.sessionManager;
    const getBranch = vi.spyOn(manager, 'getBranch').mockImplementation(() => { throw new Error('broken pending projection'); });
    manager.appendMessage(assistant());
    f.instances.get(id)!.emit({ type: 'message_start', message: assistant() });
    await rejected;
    await f.registry.settleWriters();
    expect(signal?.aborted).toBe(true);
    expect(effect).not.toHaveBeenCalled();
    getBranch.mockRestore();
  });

  it.each([false, true])('logs cleanup failures and fences only integrity loss (integrity: %s)', async integrity => {
    const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const id = binding.sessionId; const runtime = f.instances.get(id)!;
    const original = new Error('original failure');
    const cleanup = integrity ? new AggregateError([new ControlStoreError('storage_failure', 'storage failed')], 'abort failed') : new Error('abort failed');
    runtime.abort.mockRejectedValueOnce(cleanup);
    const diagnostic = vi.fn(); f.registry.options.onDiagnostic = diagnostic;
    const getBranch = vi.spyOn(runtime.session.sessionManager, 'getBranch').mockImplementation(() => { throw original; });
    runtime.session.sessionManager.appendMessage(assistant());
    runtime.emit({ type: 'message_start', message: assistant() });
    await expect(f.registry.settleWriters()).rejects.toThrow('writers did not settle cleanly');
    expect(diagnostic).toHaveBeenCalledWith({ scope: 'projection', session: id, error: original });
    expect(diagnostic).toHaveBeenCalledWith({ scope: 'registry', session: id, error: cleanup });
    expect(f.registry.fenced).toBe(integrity);
    if (!integrity) {
      expect(() => f.registry.assertAdmission()).not.toThrow();
      expect(f.registry.binding(id)).toBeUndefined();
      expect(f.store.session(id).residency).toBe('evicted');
      expect(runtime.dispose).toHaveBeenCalledOnce();
    }
    getBranch.mockRestore();
    const fault = f.registry as unknown as { failure?: unknown; failureSettlement?: Promise<void>; cancellationFailures: Set<unknown> };
    delete fault.failure; delete fault.failureSettlement; fault.cancellationFailures.clear();
  });

  it('reports automatic eviction failures and fences without an unhandled rejection', async () => {
    const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const id = binding.sessionId; const runtime = f.instances.get(id)!;
    const cleanup = new Error('runtime disposal failed');
    runtime.dispose.mockRejectedValueOnce(cleanup);
    const diagnostic = vi.fn(); f.registry.options.onDiagnostic = diagnostic;
    const getBranch = vi.spyOn(runtime.session.sessionManager, 'getBranch').mockImplementation(() => { throw new Error('projection failed before eviction'); });
    runtime.session.sessionManager.appendMessage(assistant());
    runtime.emit({ type: 'message_start', message: assistant() });
    try {
      await expect(f.registry.settleWriters()).rejects.toThrow('writers did not settle cleanly');
      expect(diagnostic).toHaveBeenCalledWith({ scope: 'registry', session: id, error: cleanup });
      expect(diagnostic).toHaveBeenCalledWith({ scope: 'registry', error: cleanup });
      expect(f.registry.fenced).toBe(true);
      expect(f.registry.binding(id)).toBe(binding);
      expect(f.store.session(id).residency).toBe('warm');
      expect(() => f.registry.assertAdmission()).toThrow('Registry is not admitting work.');
    } finally {
      getBranch.mockRestore();
      const fault = f.registry as unknown as { failure?: unknown; failureSettlement?: Promise<void> };
      await fault.failureSettlement?.catch(() => {});
      delete fault.failure; delete fault.failureSettlement;
      runtime.dispose.mockReset().mockResolvedValue(undefined);
    }
  });
});
