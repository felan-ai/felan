import { afterEach, expect, it, vi } from 'vitest';
import type { ClientEnvelope } from '@felan-ai/session-protocol';
import { OrderedAdmission } from '../src/daemon/admission.js';
import { createRegistryInteractionBroker } from '../src/daemon/broker.js';
import { HostLifecycle, type HostLifecycleOptions } from '../src/daemon/lifecycle.js';
import { fixture, fixtures, now, requestId } from './fixtures/registry.js';

afterEach(async () => { for (const cleanup of fixtures.splice(0)) await cleanup(); });

async function setup(overrides: Partial<HostLifecycleOptions> = {}) {
  const f = await fixture(); const root = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
  const broker = createRegistryInteractionBroker(f.registry); const complete = vi.fn(async () => {});
  const lifecycle = new HostLifecycle({ target: f.owner.target, identity: f.owner.identity, beginDrain: () => f.registry.beginDrain(),
    settle: async mode => { await broker.drain(); if (mode === 'drain') await f.registry.waitForDrain(); await f.registry.shutdown({ interrupt: mode === 'force' }); },
    complete, ...overrides });
  const admission = new OrderedAdmission(f.store, { now: () => now });
  async function request(mode: 'drain' | 'force' = 'drain', op: 'host.stop' | 'host.restart' = 'host.stop', notify = true) {
    const id = requestId(); const envelope = { v: 1, id, op, params: { expected: f.owner.identity, confirmed: true, mode } } as const;
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

it('does not begin shutdown when the management outcome could not be committed', async () => {
  const settle = vi.fn(async () => {}); const f = await setup({ settle }); const result = await f.request('drain', 'host.stop', false);
  f.lifecycle.afterResponse(result.id, false);
  expect(f.lifecycle.state).toBe('blocked'); expect(settle).not.toHaveBeenCalled(); expect(f.complete).not.toHaveBeenCalled();
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

it('defers a waiting question before releasing the host', async () => {
  const f = await setup(); const answer = f.broker.request({ kind: 'ask_user', questions: [{ id: 'q', question: 'Choose', options: [{ id: 'yes', title: 'Yes' }] }] },
    { kind: 'session', session: f.root.sessionId, root: f.root.sessionId });
  await f.request(); expect(await answer).toMatchObject({ state: 'deferred' });
  await vi.waitFor(() => expect(f.lifecycle.state).toBe('stopped'));
  expect(f.store.snapshot().interactions.at(-1)?.state).toBe('deferred');
});

it('stays blocked at the drain deadline and never auto-forces or releases later', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const settle = vi.fn(() => gate); const f = await setup({ settle, timeoutMs: 5 }); f.releases.add(release);
  await f.request(); await vi.waitFor(() => expect(f.lifecycle.state).toBe('blocked'));
  expect(settle).toHaveBeenCalledWith('drain'); expect(f.complete).not.toHaveBeenCalled();
  release(); await gate; await Promise.resolve(); expect(f.lifecycle.state).toBe('blocked'); expect(f.complete).not.toHaveBeenCalled();
});

it('fences an old drain continuation when explicit force supersedes it', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const settle = vi.fn((mode: 'drain' | 'force') => mode === 'drain' ? gate : Promise.resolve());
  const f = await setup({ settle }); f.releases.add(release);
  await f.request(); await vi.waitFor(() => expect(settle).toHaveBeenCalledWith('drain'));
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

it('rejects a wrong instance and unconfirmed requests without starting drain', async () => {
  const f = await setup(); const begin = vi.spyOn(f.registry, 'beginDrain');
  const value: ClientEnvelope = { v: 1, id: requestId(), op: 'host.stop', params: { expected: { ...f.owner.identity, instanceId: 'wrong' }, confirmed: true, mode: 'force' } };
  const response = await f.admission.submit(value, 'test-client', command => f.lifecycle.prepare(command));
  expect(response.outcome).toBe('rejected'); expect(begin).not.toHaveBeenCalled(); expect(f.lifecycle.state).toBe('ready');
  await expect(f.admission.submit({ ...value, id: requestId(), params: { ...value.params, expected: f.owner.identity, confirmed: false } }, 'test-client', command => f.lifecycle.prepare(command))).rejects.toThrow();
  expect(begin).not.toHaveBeenCalled();
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
