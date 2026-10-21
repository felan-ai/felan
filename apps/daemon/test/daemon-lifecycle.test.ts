import { afterEach, expect, it, vi } from 'vitest';
import type { ClientEnvelope } from '@felan-ai/session-protocol';
import { OrderedAdmission } from '../src/daemon/admission.js';
import { createRegistryInteractionBroker } from '../src/daemon/broker.js';
import { HostLifecycle, type HostLifecycleOptions } from '../src/daemon/lifecycle.js';
import { settleDaemonWork } from '../src/daemon/service.js';
import { fixture, fixtures, now, requestId } from './fixtures/registry.js';
import { gate, serverFixture } from './fixtures/server.js';

afterEach(async () => { for (const cleanup of fixtures.splice(0)) await cleanup(); });

async function setup(overrides: Partial<HostLifecycleOptions> = {}) {
  const f = await fixture(); const root = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
  const broker = createRegistryInteractionBroker(f.registry); const complete = vi.fn(async () => {});
  const lifecycle = new HostLifecycle({ target: f.owner.target, identity: f.owner.identity, beginDrain: () => f.registry.beginDrain(), endDrain: () => f.registry.endDrain(),
    canRetry: () => { f.owner.assertCurrent(); return !f.registry.fenced; },
    settle: async (mode, signal) => { await broker.drain(); if (mode === 'drain') await f.registry.waitForDrain(signal); signal.throwIfAborted(); await f.registry.shutdown({ interrupt: mode === 'force' }); },
    complete, ...overrides });
  const admission = new OrderedAdmission(f.store, { now: () => now });
  async function request(mode: 'drain' | 'force' = 'drain', op: 'host.stop' | 'host.restart' = 'host.stop', notify = true) {
    const id = requestId(); const envelope = { v: 1, id, op, params: { expected: f.owner.identity, mode } } as const;
    const response = await admission.submit(envelope, 'test-client', command => lifecycle.prepare(command));
    if (notify) lifecycle.afterResponse(id, response.outcome === 'accepted');
    return { id, envelope, response };
  }
  return { ...f, root, broker, complete, lifecycle, admission, request };
}

it('commits the management outcome before starting settlement and release', async () => {
  const settle = vi.fn(async () => {}); const f = await setup({ settle }); const result = await f.request('drain', 'host.stop', false);
  expect(result.response.outcome).toBe('accepted'); expect(settle).not.toHaveBeenCalled();
  expect(f.store.snapshot().requests.find(row => row.id === result.id)?.phase).toBe('terminal');
  f.lifecycle.afterResponse(result.id); await vi.waitFor(() => expect(f.lifecycle.state).toBe('stopped'));
  expect(settle).toHaveBeenCalledOnce(); expect(f.complete).toHaveBeenCalledWith('stop');
});

it('never retries the effect of the same durable request', async () => {
  const f = await setup(); const result = await f.request(); await vi.waitFor(() => expect(f.lifecycle.state).toBe('stopped'));
  expect(await f.admission.submit(result.envelope, 'test-client', command => f.lifecycle.prepare(command))).toEqual(result.response);
  f.lifecycle.afterResponse(result.id); expect(f.complete).toHaveBeenCalledOnce();
});

it('returns to ready without shutdown when the management outcome could not be committed', async () => {
  const settle = vi.fn(async () => {}); const f = await setup({ settle }); const result = await f.request('drain', 'host.stop', false);
  f.lifecycle.afterResponse(result.id, false);
  expect(f.lifecycle.state).toBe('ready'); expect(settle).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
});

it('waits for existing work without aborting it and refuses new turns', async () => {
  const f = await setup(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); f.releases.add(release);
  const runId = requestId(); f.store.admit({ v: 1, id: runId, op: 'prompt', session: f.root.sessionId, params: { text: 'existing' } }, 'test-client');
  const running = f.registry.runAdmitted(runId, f.root.sessionId, { kind: 'tui', attachment: 'original-client' }, () => gate);
  await f.request(); expect(f.lifecycle.state).toBe('draining');
  expect(f.instances.get(f.root.sessionId)?.abort).not.toHaveBeenCalled();
  expect(() => f.registry.create({ cwd: f.cwd, target: { kind: 'new' } })).toThrow('draining');
  await expect(f.registry.runAdmitted(requestId(), f.root.sessionId, { kind: 'tui', attachment: 'new-client' }, async () => {})).rejects.toThrow('draining');
  release(); await running; await vi.waitFor(() => expect(f.lifecycle.state).toBe('stopped'));
});

it.each([false, true])('drains a root turn after its final assistant message (started during drain check: %s)', async late => {
  const settling = gate(); const release = gate();
  const f = await serverFixture({ extension: pi => {
    pi.on('agent_end', async () => { settling.resolve(); await release.promise; });
  } });
  fixtures.push(async () => { release.resolve(); await f.dispose(); });
  let running: Promise<void>;
  if (late) {
    const count = f.registry.processes.interruptibleCount.bind(f.registry.processes);
    vi.spyOn(f.registry.processes, 'interruptibleCount').mockImplementationOnce(async () => {
      running = f.root.runtime.session.prompt('existing'); await settling.promise;
      return count();
    });
  } else {
    running = f.root.runtime.session.prompt('existing'); await settling.promise;
  }
  const abort = vi.spyOn(f.root.runtime.session, 'abort');
  const complete = vi.fn(async () => {});
  const lifecycle = new HostLifecycle({ target: f.owner.target, identity: f.owner.identity,
    beginDrain: () => f.registry.beginDrain(), endDrain: () => f.registry.endDrain(),
    settle: (mode, signal) => settleDaemonWork(f.registry, createRegistryInteractionBroker(f.registry), mode, signal), complete });
  const admission = new OrderedAdmission(f.store, { now: () => now });
  const stopId = requestId();
  const response = await admission.submit({ v: 1, id: stopId, op: 'host.stop', params: { expected: f.owner.identity, mode: 'drain' } },
    'test-client', command => lifecycle.prepare(command));
  expect(response.outcome).toBe('accepted'); lifecycle.afterResponse(stopId);
  await settling.promise;
  expect(f.root.runtime.session.messages.some(message => message.role === 'assistant')).toBe(true);
  expect(f.root.runtime.session.isIdle).toBe(false);
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(lifecycle.state).toBe('draining'); expect(complete).not.toHaveBeenCalled(); expect(abort).not.toHaveBeenCalled();
  expect(() => f.registry.assertNewWork()).toThrow('draining');
  release.resolve(); await running!;
  await vi.waitFor(() => expect(lifecycle.state).toBe('stopped'));
  expect(complete).toHaveBeenCalledWith('stop');
  expect(f.store.session(f.root.sessionId).run.state).toBe('idle');
});

it('defers a waiting question before releasing the host', async () => {
  const f = await setup(); const answer = f.broker.request({ kind: 'input', title: 'Choose' },
    { kind: 'session', session: f.root.sessionId, root: f.root.sessionId }, { deferrable: true });
  await f.request(); expect(await answer).toMatchObject({ state: 'deferred' });
  await vi.waitFor(() => expect(f.lifecycle.state).toBe('stopped'));
  expect(f.store.snapshot().interactions.at(-1)?.state).toBe('deferred');
});

it('keeps admission closed when an accepted drain misses its deadline', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const settle = vi.fn(() => gate); const f = await setup({ settle, timeoutMs: 5 }); f.releases.add(release);
  await f.request(); await vi.waitFor(() => expect(f.lifecycle.state).toBe('blocked'));
  expect(settle.mock.calls.map(([mode]) => mode)).toEqual(['drain']); expect(f.complete).not.toHaveBeenCalled();
  expect(f.lifecycle.blocked).toMatchObject({ recoverable: false, step: 'settlement-deadline' });
  expect(() => f.registry.create({ cwd: f.cwd, target: { kind: 'new' } })).toThrow('draining');
  release(); await gate; await Promise.resolve(); expect(f.lifecycle.state).toBe('blocked'); expect(f.complete).not.toHaveBeenCalled();
});

it('keeps admission closed when accepted drain settlement fails', async () => {
  const settle = vi.fn(async () => { throw new Error('fixture drain failure'); }); const f = await setup({ settle });
  await f.request(); await vi.waitFor(() => expect(f.lifecycle.state).toBe('blocked'));
  expect(f.lifecycle.blocked).toMatchObject({ recoverable: true, message: 'Error: fixture drain failure' });
  expect(() => f.registry.assertNewWork()).toThrow('draining');
  expect(f.complete).not.toHaveBeenCalled();
});

it('stops waiting for active work at the drain deadline without releasing ownership or reopening admission', async () => {
  const f = await setup({ timeoutMs: 20 });
  const active = vi.spyOn(f.registry, 'activeWork').mockResolvedValue(1);
  const shutdown = vi.spyOn(f.registry, 'shutdown');
  await f.request(); await vi.waitFor(() => expect(f.lifecycle.state).toBe('blocked'));
  expect(f.lifecycle.blocked).toMatchObject({ recoverable: false, step: 'settlement-deadline' });
  const checks = active.mock.calls.length;
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(active).toHaveBeenCalledTimes(checks); expect(shutdown).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
  expect(() => f.owner.assertCurrent()).not.toThrow(); expect(() => f.registry.assertNewWork()).toThrow('draining');
});

it('fences an old drain continuation when explicit force supersedes it', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const settle = vi.fn((mode: 'drain' | 'force') => mode === 'drain' ? gate : Promise.resolve());
  const f = await setup({ settle }); f.releases.add(release);
  await f.request(); await vi.waitFor(() => expect(settle.mock.calls.map(([mode]) => mode)).toEqual(['drain']));
  await f.request('force'); await vi.waitFor(() => expect(f.lifecycle.state).toBe('stopped'));
  release(); await gate; await Promise.resolve(); expect(f.complete).toHaveBeenCalledOnce();
  expect(settle.mock.calls.map(([mode]) => mode)).toEqual(['drain', 'force']);
});

it('persists the original run identity and origin as interrupted after forced settlement', async () => {
  const f = await setup(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); f.releases.add(release);
  const originalAbort = f.instances.get(f.root.sessionId)!.abort.getMockImplementation()!;
  f.instances.get(f.root.sessionId)!.abort.mockImplementation(async () => { release(); await originalAbort(); });
  const id = requestId(); f.store.admit({ v: 1, id, op: 'prompt', session: f.root.sessionId, params: { text: 'running' } }, 'test-client');
  const running = f.registry.runAdmitted(id, f.root.sessionId, { kind: 'tui', attachment: 'original-client' }, () => gate);
  const before = f.store.session(f.root.sessionId).run;
  await f.request('force'); await running; await vi.waitFor(() => expect(f.lifecycle.state).toBe('stopped'));
  expect(f.store.session(f.root.sessionId).run).toEqual({ ...before, state: 'interrupted' });
  expect(() => f.store.interruptSessionRun(f.root.sessionId, 'stale-run')).toThrow('identity changed');
  const revision = f.store.session(f.root.sessionId).revision; f.store.interruptSessionRun(f.root.sessionId, before.id!);
  expect(f.store.session(f.root.sessionId).revision).toBe(revision);
});

it('rejects a wrong instance without starting drain', async () => {
  const f = await setup(); const begin = vi.spyOn(f.registry, 'beginDrain');
  const value: ClientEnvelope = { v: 1, id: requestId(), op: 'host.stop', params: { expected: { ...f.owner.identity, instanceId: 'wrong' }, mode: 'force' } };
  const response = await f.admission.submit(value, 'test-client', command => f.lifecycle.prepare(command));
  expect(response.outcome).toBe('rejected'); expect(begin).not.toHaveBeenCalled(); expect(f.lifecycle.state).toBe('ready');
});

it('keeps cleanup failures blocked without releasing ownership', async () => {
  const f = await setup({ settle: async () => { throw new Error('fixture cleanup failure'); } });
  await f.request('force', 'host.restart'); await vi.waitFor(() => expect(f.lifecycle.state).toBe('blocked'));
  expect(f.complete).not.toHaveBeenCalled(); expect(() => f.owner.assertCurrent()).not.toThrow();
});

it('can finish an already-settled drain without reopening session admission', async () => {
  const f = await setup(); f.registry.beginDrain(); await f.registry.shutdown();
  expect(() => f.registry.beginDrain()).not.toThrow();
  expect(() => f.registry.create({ cwd: f.cwd, target: { kind: 'new' } })).toThrow('not admitting');
});

it('retains per-session shutdown failures, rejects drain durably and retries only unfinished services with force', async () => {
  const f = await setup(); const successful = { busy: () => false, settle: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
  let fail = true;
  const failed = { busy: () => false, settle: vi.fn(async (mode?: string) => {
    if (mode !== 'drain' && fail) { fail = false; throw new Error('api_key=sk-test-12345678\nservice failed'); }
  }), dispose: vi.fn(async () => {}) };
  f.registry.registerService(f.root.sessionId, successful); f.registry.registerService(f.root.sessionId, failed);
  await f.request(); await vi.waitFor(() => expect(f.lifecycle.state).toBe('blocked'));
  const blocked = f.lifecycle.blocked;
  expect(blocked).toMatchObject({ recoverable: true, step: 'session-services', session: f.root.sessionId, pid: process.pid });
  expect(blocked!.since).toBeGreaterThan(0); expect(blocked!.message).toContain('[redacted] service failed'); expect(blocked!.message).not.toContain('sk-test');
  for (const op of ['host.stop', 'host.restart'] as const) {
    const rejected = await f.request('drain', op);
    expect(rejected.response).toMatchObject({ outcome: 'rejected', error: { code: 'host_blocked', message: expect.stringContaining('Retry with force') } });
    expect(f.lifecycle.blocked).toEqual(blocked);
    expect(await f.admission.submit(rejected.envelope, 'test-client', command => f.lifecycle.prepare(command))).toEqual(rejected.response);
  }
  expect(successful.dispose).toHaveBeenCalledOnce(); expect(failed.dispose).not.toHaveBeenCalled();
  await f.request('force'); await vi.waitFor(() => expect(f.lifecycle.state).toBe('stopped'));
  expect(f.lifecycle.blocked).toBeUndefined(); expect(f.complete).toHaveBeenCalledOnce();
  expect(successful.dispose).toHaveBeenCalledOnce(); expect(failed.dispose).toHaveBeenCalledOnce();
  expect(f.instances.get(f.root.sessionId)!.dispose).toHaveBeenCalledOnce();
});

it('replaces blocked diagnostics when a forced retry fails at a different step', async () => {
  const f = await setup(); let calls = 0;
  f.registry.registerService(f.root.sessionId, { busy: () => false, settle: async mode => {
    if (mode !== 'drain' && calls++ === 0) throw new Error('first failure');
  }, dispose: async () => {} });
  const dispose = f.instances.get(f.root.sessionId)!.dispose;
  dispose.mockRejectedValueOnce(new Error('second failure'));
  await f.request(); await vi.waitFor(() => expect(f.lifecycle.blocked?.step).toBe('session-services'));
  await f.request('force'); await vi.waitFor(() => expect(f.lifecycle.blocked?.step).toBe('session-runtime'));
  expect(f.lifecycle.blocked).toMatchObject({ recoverable: true, message: 'Error: second failure', session: f.root.sessionId });
  await f.request('force'); await vi.waitFor(() => expect(f.lifecycle.state).toBe('stopped'));
});

it('does not repeat runtime disposal after a later settlement step fails', async () => {
  const f = await setup(); const settle = vi.spyOn(f.registry.projection(f.root.sessionId), 'settleRun');
  f.instances.get(f.root.sessionId)!.abort.mockResolvedValue(undefined);
  settle.mockImplementationOnce(() => { throw new Error('store failure'); });
  await f.request('force'); await vi.waitFor(() => expect(f.lifecycle.blocked?.step).toBe('session-run'));
  await f.request('force'); await vi.waitFor(() => expect(f.lifecycle.state).toBe('stopped'));
  expect(f.instances.get(f.root.sessionId)!.dispose).toHaveBeenCalledOnce();
});

it('cannot retry ownership loss or a failure after release begins', async () => {
  const complete = vi.fn(async () => { throw new Error('release failure'); }); const f = await setup({ complete });
  await f.request('force'); await vi.waitFor(() => expect(f.lifecycle.state).toBe('blocked'));
  expect(f.lifecycle.blocked).toMatchObject({ recoverable: false, step: 'release', message: 'Error: release failure' });
  expect((await f.request('force')).response).toMatchObject({ outcome: 'rejected', error: { code: 'host_blocked', message: expect.stringContaining(`terminate the daemon process ${process.pid}`) } });
  expect(complete).toHaveBeenCalledOnce();
  f.lifecycle.block(new Error('owner changed'), 'ownership-lost');
  expect(f.lifecycle.blocked).toMatchObject({ recoverable: false, step: 'ownership-lost' });
  expect((await f.request('force')).response).toMatchObject({ outcome: 'rejected', error: { code: 'host_blocked' } });
});

it('cannot retry a fenced registry or race settlement still running after its deadline', async () => {
  const f = await setup({ canRetry: () => false, settle: async () => { throw new Error('fenced'); } });
  await f.request('force'); await vi.waitFor(() => expect(f.lifecycle.blocked).toMatchObject({ recoverable: false }));
  expect((await f.request('force')).response).toMatchObject({ outcome: 'rejected', error: { code: 'host_blocked' } });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const timed = await setup({ settle: () => gate, timeoutMs: 5 }); timed.releases.add(release);
  await timed.request('force'); await vi.waitFor(() => expect(timed.lifecycle.blocked).toMatchObject({ recoverable: false, step: 'settlement-deadline' }));
  release(); await gate;
});

it('rechecks ownership and registry eligibility before accepting blocked force recovery', async () => {
  let eligible = true; const settle = vi.fn(async () => { throw new Error('settlement failed'); });
  const f = await setup({ canRetry: () => eligible, settle });
  await f.request('force'); await vi.waitFor(() => expect(f.lifecycle.blocked?.recoverable).toBe(true));
  const since = f.lifecycle.blocked!.since; eligible = false;
  expect((await f.request('force')).response).toMatchObject({ outcome: 'rejected', error: { code: 'host_blocked' } });
  expect(f.lifecycle.blocked).toMatchObject({ recoverable: false, since }); expect(settle).toHaveBeenCalledOnce();
});

it('force finishes a previously failed close without replaying its rejected attempt', async () => {
  const f = await setup(); let fail = true;
  const disposed = vi.fn(async () => {});
  f.registry.registerService(f.root.sessionId, { busy: () => false, settle: async () => {
    if (fail) { fail = false; throw new Error('close failed once'); }
  }, dispose: disposed });
  await expect(f.registry.close(f.root.sessionId)).rejects.toThrow('close failed once');
  await f.request('force'); await vi.waitFor(() => expect(f.lifecycle.state).toBe('stopped'));
  expect(f.store.session(f.root.sessionId).state).toBe('closed'); expect(disposed).toHaveBeenCalledOnce();
});

it('force preserves descendant close intent and closes children before their parent after a failed close', async () => {
  const f = await setup();
  const child = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, rootSessionId: f.root.sessionId, parentSessionId: f.root.sessionId });
  const sibling = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, rootSessionId: f.root.sessionId, parentSessionId: f.root.sessionId });
  f.instances.get(child.sessionId)!.abort.mockRejectedValueOnce(new Error('child abort failed once'));
  await expect(f.registry.close(f.root.sessionId)).rejects.toThrow('child abort failed once');
  await f.request('force'); await vi.waitFor(() => expect(f.lifecycle.state).toBe('stopped'));
  for (const binding of [f.root, child, sibling]) {
    expect(f.store.session(binding.sessionId).state).toBe('closed');
    expect(f.instances.get(binding.sessionId)!.dispose).toHaveBeenCalledOnce();
  }
  const rootDisposed = f.instances.get(f.root.sessionId)!.dispose.mock.invocationCallOrder[0]!;
  expect(f.instances.get(child.sessionId)!.dispose.mock.invocationCallOrder[0]!).toBeLessThan(rootDisposed);
  expect(f.instances.get(sibling.sessionId)!.dispose.mock.invocationCallOrder[0]!).toBeLessThan(rootDisposed);
});
