import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlStoreError } from '../src/daemon/control-state.js';
import { assistant, deferred, fixture, fixtures, requestId, supported } from './fixtures/registry.js';

afterEach(async () => { for (const cleanup of fixtures.splice(0)) await cleanup(); });

describe.skipIf(!supported)('session-local projection failure', () => {
  it('settles an idle projection failure without poisoning drain or close and reopen', async () => {
    const f = await fixture(); const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const id = binding.sessionId; const runtime = f.instances.get(id)!;
    const failure = new Error('idle projection failure');
    const diagnostic = vi.fn(); f.registry.options.onDiagnostic = diagnostic;
    const getBranch = vi.spyOn(runtime.session.sessionManager, 'getBranch').mockImplementation(() => { throw failure; });
    runtime.session.sessionManager.appendMessage(assistant());
    runtime.emit({ type: 'message_start', message: assistant() });
    await f.registry.settleWriters();
    expect(diagnostic.mock.calls).toEqual([[{ scope: 'projection', session: id, error: failure }]]);
    expect(f.store.session(id).run.state).toBe('idle');
    expect(f.registry.fenced).toBe(false);
    await expect(f.registry.attach(id, { principal: 'fixture', kind: 'headless' })).rejects.toMatchObject({ code: 'unavailable' });
    f.registry.beginDrain();
    await f.registry.waitForDrain();
    f.registry.endDrain();
    getBranch.mockRestore();
    await f.registry.close(id);
    const reopened = await f.registry.restore(id);
    await reopened.runtime.session.prompt('works after reopening');
    await f.registry.settleWriters();
    expect(f.registry.projection(id).snapshot().run.state).toBe('idle');
  });

  it.each(['subscription', 'timer'] as const)('aborts an active turn after a %s failure without retrying projection or resuming queued work', async source => {
    const f = await fixture();
    const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const other = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const id = binding.sessionId;
    const runtime = f.instances.get(id)!;
    const started = deferred(); const stopped = deferred();
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
    runtime.abort.mockImplementation(async () => { await foregroundStarted.promise; active = false; stopped.resolve(); });
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
    await run;
    await f.registry.settleWriters();
    expect(runtime.abort).toHaveBeenCalledTimes(1);
    expect(cancelForeground).toHaveBeenCalledWith(id);
    expect(clearQueue).toHaveBeenCalledTimes(1);
    expect(runtime.queue.followUp).toEqual([]);
    expect(resume).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(refreshes);
    expect(presentations).not.toHaveBeenCalled();
    expect(f.store.session(id).run.state).toBe('idle');
    expect(observed.slice(-2)).toEqual(['cancelling', 'idle']);
    expect(() => f.registry.assertDispatch(id)).toThrow('Session projection failed');
    expect(() => f.registry.assertServiceAccess(id)).toThrow('Session projection failed');
    await f.registry.cancel(id);
    expect(runtime.abort).toHaveBeenCalledTimes(1);
    expect(f.registry.fenced).toBe(false);
    expect(runtime.session.sessionManager.getEntries()).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.objectContaining({ role: 'user', content: 'keep canonical data' }) }),
    ]));
    await other.runtime.session.prompt('unrelated session still works');
    expect(f.registry.projection(other.sessionId).snapshot().history.entries).toHaveLength(2);
    getBranch?.mockRestore(); getName?.mockRestore();
    unsubscribe(); f.registry.detach(id, attached.attachment);
    await f.registry.close(id);
    expect(refresh).toHaveBeenCalledTimes(refreshes);
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
    if (!integrity) expect(() => f.registry.assertAdmission()).not.toThrow();
    getBranch.mockRestore();
    const fault = f.registry as unknown as { failure?: unknown; failureSettlement?: Promise<void>; cancellationFailures: Set<unknown> };
    delete fault.failure; delete fault.failureSettlement; fault.cancellationFailures.clear();
  });
});
