import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, AgentRuntimeProcess } from '@felan-ai/agent-core';
import { LIMITS, canonicalRequestPayload, type OperationParams } from '@felan-ai/session-protocol';
import type { DaemonControlStore } from '../src/daemon/control-store.js';
import { RegistryProcesses } from '../src/daemon/processes.js';
import { OrderedAdmission } from '../src/daemon/admission.js';
import { forkSession } from '../src/daemon/commands.js';
import type { ProjectionOutput as RegistryOutput } from '../src/daemon/projection.js';
import { gate, now, requestId, serverFixture } from './fixtures/server.js';

const fixtures: Awaited<ReturnType<typeof serverFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0).reverse()) await f.dispose(); });
async function fixture(options: Parameters<typeof serverFixture>[0] = {}) { const f = await serverFixture(options); fixtures.push(f); return f; }

describe('public processed queue observation', () => {
  it('creates and refreshes a session when its profile does not expose an observable agent', async () => {
    const f = await fixture(); const open = f.profile.openSession.bind(f.profile);
    vi.spyOn(f.profile, 'openSession').mockImplementation(async request => {
      const binding = await open(request);
      const session = new Proxy(binding.runtime.session, { get(target, key) {
        if (key === 'agent') return undefined;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const runtime = new Proxy(binding.runtime, { get(target, key) {
        if (key === 'session') return session;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      return { ...binding, runtime };
    });
    const binding = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, model: f.root.runtime.session.model! });
    const projection = f.registry.projection(binding.sessionId);
    expect(binding.runtime.session.agent).toBeUndefined(); expect(projection.canObserveQueue).toBe(false);
    expect(() => projection.refresh()).not.toThrow(); expect(projection.snapshot().queue).toEqual([]);
  });

  it('observes the actual post-transform payload and does not invent a queue entry for handled input', async () => {
    const f = await fixture({ extension: pi => { pi.on('input', async event => {
      if (event.text === 'handled') return { action: 'handled' };
      if (event.text === 'raw') return { action: 'transform', text: 'processed', images: [{ type: 'image', mimeType: 'image/png', data: 'AA==' }] };
      return undefined;
    }); } });
    const session = f.root.runtime.session; const projection = f.registry.projection(f.root.sessionId);
    const observed = await projection.withQueueOrigin({ kind: 'tui', attachment: 'one' }, () => session.steer('raw'));
    expect(observed.value).toBe('queued'); expect(observed.ids).toHaveLength(1);
    expect(projection.snapshot().queue[0]?.prompt).toEqual({ text: '', attachments: [{ type: 'text', text: 'processed' }, { type: 'image', mimeType: 'image/png', data: 'AA==' }] });
    session.clearQueue();
    const handled = await projection.withQueueOrigin({ kind: 'tui', attachment: 'one' }, () => session.followUp('handled'));
    expect(handled).toEqual({ value: 'handled', ids: [] });
    expect(projection.snapshot().queue).toEqual([]); expect(session.agent.hasQueuedMessages()).toBe(false);
  });

  it('assigns occurrence IDs and async origins without text matching, preserving transformed images', async () => {
    const f = await fixture(); const session = f.root.runtime.session; const projection = f.registry.projection(f.root.sessionId);
    const message = { role: 'user' as const, content: [{ type: 'text' as const, text: 'same transformed text' }, { type: 'image' as const, mimeType: 'image/png', data: '/w==' }], timestamp: now };
    const release = gate();
    const first = projection.withQueueOrigin({ kind: 'tui', attachment: 'first' }, async () => { await release.promise; session.agent.steer(message); });
    const second = await projection.withQueueOrigin({ kind: 'headless', attachment: 'second' }, async () => { session.agent.steer(message); });
    release.resolve(); const earlier = await first;
    const queue = projection.snapshot().queue;
    expect(queue.map(item => item.id)).toEqual([...second.ids, ...earlier.ids]);
    expect(new Set(queue.map(item => item.id)).size).toBe(2);
    expect(queue.map(item => item.origin)).toEqual([{ kind: 'headless', attachment: 'second' }, { kind: 'tui', attachment: 'first' }]);
    expect(queue[0]!.prompt).toEqual({ text: '', attachments: [{ type: 'text', text: 'same transformed text' }, { type: 'image', mimeType: 'image/png', data: '/w==' }] });
    expect(session.agent.peekQueuedMessages()[0]).toBe(message);
    session.clearQueue();
  });

  it('tracks actual native enqueue/delivery and preserves the other kind when a public clear occurs', async () => {
    const f = await fixture(); const session = f.root.runtime.session; const projection = f.registry.projection(f.root.sessionId);
    const first = await projection.withQueueOrigin({ kind: 'tui', attachment: 'a' }, () => session.steer('same'));
    const second = await projection.withQueueOrigin({ kind: 'tui', attachment: 'b' }, () => session.followUp('same'));
    expect(projection.snapshot().queue.map(item => item.id)).toEqual([...first.ids, ...second.ids]);
    session.agent.clearSteeringQueue();
    expect(projection.snapshot().queue.map(item => item.id)).toEqual(second.ids);
    await session.prompt('start', { source: 'rpc', expandPromptTemplates: false });
    expect(projection.snapshot().queue).toEqual([]);
  });

  it('omits hidden custom messages from the queue without a notice and shows visible ones as previews', async () => {
    const f = await fixture(); const session = f.root.runtime.session; const projection = f.registry.projection(f.root.sessionId);
    const hidden = { role: 'custom' as const, customType: 'synthetic', content: 'hidden', display: false, timestamp: now };
    session.agent.followUp(hidden);
    expect(projection.snapshot()).toMatchObject({ queue: [], presentation: [] });
    expect(session.agent.peekQueuedMessages()[0]).toBe(hidden);
    session.clearQueue();
    const visible = { role: 'custom' as const, customType: 'completion', content: 'Execution completion: done', display: true, timestamp: now };
    session.agent.steer(visible);
    expect(projection.snapshot()).toMatchObject({ queue: [{ kind: 'steer', prompt: { text: 'Execution completion: done' }, origin: { kind: 'automation', source: 'runtime' } }], presentation: [] });
    session.clearQueue();
    expect(projection.snapshot().queue).toEqual([]);
  });

  it('previews invalid user input and bounds oversized prompts without losing observation', async () => {
    const f = await fixture(); const session = f.root.runtime.session; const projection = f.registry.projection(f.root.sessionId);
    session.agent.steer({ role: 'user', content: [{ type: 'text', text: 'lone \ud800' }, { type: 'image', mimeType: 'image/bmp', data: '/w==' }], timestamp: now });
    expect(projection.snapshot().queue[0]?.prompt).toEqual({ text: 'lone \ufffd\n[image omitted]', });
    session.clearQueue();
    session.agent.followUp({ role: 'user', content: 'x'.repeat(LIMITS.pageBytes / 2), timestamp: now });
    const large = projection.snapshot();
    expect(large.queue[0]!.prompt.text.endsWith('\u2026')).toBe(true);
    expect(Buffer.byteLength(large.queue[0]!.prompt.text)).toBeLessThanOrEqual(LIMITS.statusTextBytes + 3);
    expect(projection.canObserveQueue).toBe(true);
    expect(large.presentation.some(item => item.id === 'queue-observation')).toBe(false);
    session.clearQueue();
    expect(projection.snapshot().queue).toEqual([]);
  });

  it('persists only user queue identities for restart recovery', async () => {
    const f = await fixture(); const session = f.root.runtime.session; const projection = f.registry.projection(f.root.sessionId);
    session.agent.steer({ role: 'user', content: 'typed input', timestamp: now });
    session.agent.followUp({ role: 'custom', customType: 'completion', content: 'automation notice', display: true, timestamp: now });
    const [user, automation] = projection.snapshot().queue;
    expect(automation?.origin).toEqual({ kind: 'automation', source: 'runtime' });
    const record = f.store.session(f.root.sessionId).projections.find(row => row.value.type === 'queue');
    expect(record?.value).toMatchObject({ type: 'queue', ids: [user!.id] });
    session.clearQueue();
  });

  it('leaves excessive native queues untouched while disclosing incomplete representation', async () => {
    const f = await fixture(); const session = f.root.runtime.session; const projection = f.registry.projection(f.root.sessionId);
    session.clearQueue();
    for (let index = 0; index < 257; index++) session.agent.steer({ role: 'user', content: 'bounded observation', timestamp: now });
    const snapshot = projection.snapshot();
    expect(snapshot.queue).toEqual([]); expect(projection.canObserveQueue).toBe(false);
    expect(snapshot.presentation.some(item => 'text' in item && item.text.includes('observation is incomplete'))).toBe(true);
    expect(session.agent.hasQueuedMessages()).toBe(true);
    session.clearQueue();
  });

  it('restores public wrappers only when it still owns the installed property', async () => {
    const f = await fixture(); const session = f.root.runtime.session; const projection = f.registry.projection(f.root.sessionId);
    const replacement = session.agent.steer.bind(session.agent); session.agent.steer = replacement;
    projection.dispose(); expect(session.agent.steer).toBe(replacement);
  });

  it('clears phantom and lost observations only after a true idle and empty native queue', async () => {
    const f = await fixture(); const session = f.root.runtime.session; const projection = f.registry.projection(f.root.sessionId);
    session.agent.steer({ role: 'user', content: 'not delivered', timestamp: now });
    expect(projection.snapshot().queue).toHaveLength(1);
    session.agent.reset(); expect(projection.snapshot().queue).toEqual([]);
    for (let index = 0; index < 257; index++) session.agent.followUp({ role: 'user', content: 'overflow', timestamp: now });
    expect(projection.canObserveQueue).toBe(false); projection.refresh(); expect(projection.canObserveQueue).toBe(false);
    session.agent.reset(); projection.refresh(); expect(projection.canObserveQueue).toBe(true);
    expect(projection.snapshot().queue).toEqual([]);
  });
});

function processRuntime(f: Awaited<ReturnType<typeof serverFixture>>, session = f.root.sessionId) {
  let running = true; let output = new Uint8Array([0, 255, 3, 13, 0, 128]);
  const writes: Uint8Array[] = [];
  const process: AgentRuntimeProcess = {
    pid: undefined,
    read: vi.fn(async (offset, options) => {
      const data = output.slice(offset, offset + (options?.maxBytes ?? output.byteLength));
      return { output: data, nextOffset: offset + data.byteLength, running, ...(running ? {} : { exitCode: 0 }) };
    }),
    write: vi.fn(async bytes => { writes.push(new Uint8Array(bytes)); }),
    terminate: vi.fn(async () => { running = false; }), dispose: vi.fn(async () => {}),
  };
  const start = vi.fn(async () => process);
  f.registry.processes.wrap({ ...f.root.agentRuntime, processes: { startShell: start } }, { session, root: f.store.session(session).root });
  const request = requestId();
  f.store.admit({ v: 1, id: request, op: 'shell.execute', session, params: { command: 'synthetic', includeInContext: false } }, 'owner');
  return { process, start, request, writes, setOutput: (bytes: Uint8Array) => { output = new Uint8Array(bytes); } };
}

describe('registry-backed command dispatch', () => {
  it('publishes the actual dispatch checkpoint before the running transition without a revision gap', async () => {
    const f = await fixture(); const id = f.root.sessionId; const revision = f.store.session(id).revision;
    const events: RegistryOutput[] = [];
    f.registry.subscribe(id, event => { events.push(event); if ('rev' in event) expect(f.store.session(id).revision).toBe(event.rev); });
    const request = requestId(); f.store.admit({ v: 1, id: request, op: 'prompt', session: id, params: { text: 'work' } }, 'owner');
    const mark = vi.spyOn(f.store, 'markDispatched');
    await f.registry.runAdmitted(request, id, { kind: 'tui', attachment: 'fixture' }, async () => {
      expect(f.store.snapshot().requests[0]?.phase).toBe('dispatch_intent');
    });
    const runs = events.filter(event => 'change' in event && event.change.type === 'run.updated');
    expect(runs.map(event => 'rev' in event ? event.rev : 0)).toEqual([revision + 1, revision + 2, revision + 3]);
    expect(runs.map(event => 'change' in event && 'run' in event.change && event.change.run && typeof event.change.run === 'object'
      && 'state' in event.change.run ? event.change.run.state : '')).toEqual(['idle', 'running', 'idle']);
    expect(mark).toHaveBeenCalledExactlyOnceWith(request);
  });

  it('holds a non-run writer across async work and applies tightening without waiting for it', async () => {
    const f = await fixture(); const id = f.root.sessionId; const entered = gate(); const release = gate();
    const request = requestId(); f.store.admit({ v: 1, id: request, op: 'session.rename', session: id, params: { name: 'later' } }, 'owner');
    const operation = f.registry.mutateAdmitted(request, id, async context => {
      entered.resolve(); await release.promise; context.assertCurrent(); context.session.setSessionName('later');
    });
    try {
      await entered.promise; expect(await f.registry.evictIdle()).toEqual([]);
      f.registry.tightenPolicy(id);
      expect(f.store.session(id).policy.effective).toBe('acp-strict');
    } finally { release.resolve(); }
    await operation;
    expect(f.store.session(id).policy.effective).toBe('acp-strict');
  });

  it('lets close join a non-run mutation without the mutation joining its own barrier', async () => {
    const f = await fixture(); const id = f.root.sessionId; const entered = gate(); const release = gate();
    const request = requestId(); f.store.admit({ v: 1, id: request, op: 'session.rename', session: id, params: { name: 'late' } }, 'owner');
    const operation = f.registry.mutateAdmitted(request, id, async context => { entered.resolve(); await release.promise; context.assertCurrent(); });
    const rejected = expect(operation).rejects.toThrow('closing'); await entered.promise;
    const closing = f.registry.close(id);
    release.resolve(); await rejected; await closing;
    expect(f.store.session(id).state).toBe('closed');
  });

  it('seals retained root and child process ports before close awaits while preserving scoped cleanup writes', async () => {
    const f = await fixture(); const root = f.root.sessionId;
    const child = await f.registry.create({ cwd: f.cwd, rootSessionId: root, parentSessionId: root, target: { kind: 'new' }, model: f.root.runtime.session.model! });
    const start = vi.fn(async (): Promise<AgentRuntimeProcess> => { throw new Error('Unexpected process creation'); });
    const write = vi.fn(async () => {});
    const runtimes = [root, child.sessionId].map(session => f.registry.processes.wrap({ ...f.root.agentRuntime, writeFile: write,
      processes: { startShell: start } }, { session, root }));
    f.registry.registerService(root, { busy: () => false, settle: async () => {
      await runtimes[0]!.writeFile('cleanup', new Uint8Array());
      await expect(runtimes[0]!.processes!.startShell('no cleanup spawn')).rejects.toThrow('closed');
    }, dispose: async () => {} });
    const closing = f.registry.close(root);
    for (const runtime of runtimes) await expect(runtime.processes!.startShell('no retained spawn')).rejects.toThrow('closed');
    await closing;
    expect(start).not.toHaveBeenCalled(); expect(write).toHaveBeenCalledOnce();
  });

  it('rejects lifecycle callbacks and unsupported operations from the non-run mutation port', async () => {
    const f = await fixture(); const id = f.root.sessionId; const effect = vi.fn();
    for (const op of ['close', 'cancel', 'session.reload'] as const) {
      const request = requestId(); f.store.admit({ v: 1, id: request, op, session: id, params: {} }, 'owner');
      await expect(f.registry.mutateAdmitted(request, id, effect)).rejects.toThrow('supported non-run');
    }
    expect(effect).not.toHaveBeenCalled();
  });

  it('revokes a non-run dispatch guard once its effect has settled', async () => {
    const f = await fixture(); const id = f.root.sessionId; const request = requestId(); let retained!: () => void;
    f.store.admit({ v: 1, id: request, op: 'session.rename', session: id, params: { name: 'renamed' } }, 'owner');
    await f.registry.mutateAdmitted(request, id, async context => {
      retained = context.assertCurrent; context.assertCurrent(); context.session.setSessionName('renamed');
    });
    expect(f.store.session(id).title).toBe('renamed');
    expect(() => retained()).toThrow('has settled');
  });

  for (const kind of ['entry', 'position'] as const) it(`forks before a complete-selector ${kind}, including an inactive branch`, async () => {
    const f = await fixture(); const id = f.root.sessionId; const session = f.root.runtime.session;
    await session.prompt('first'); const firstLeaf = session.sessionManager.getLeafId()!;
    await session.prompt('inactive selected'); const choices = session.getUserMessagesForForking();
    await session.navigateTree(firstLeaf, { summarize: false }); await session.prompt('active sibling');
    f.registry.projection(id).refresh();
    const attachment = await f.registry.attach(id, { principal: 'owner', kind: 'tui' });
    const leaf = session.sessionManager.getLeafId(); const path = f.store.session(id).piPath; const before = await readFile(path);
    const from: OperationParams<'fork'>['from'] = kind === 'entry' ? { kind, entryId: choices[1]!.entryId } : { kind, position: 1 };
    const request = requestId(); const admission = new OrderedAdmission(f.store, { now: () => now });
    const response = await admission.submit({ v: 1, id: request, op: 'fork', session: id, params: { from } }, 'owner', async command => {
      command.assertDispatch(); return { response: { v: 1, re: request, outcome: 'accepted', result: await forkSession(f.registry, request, id, { from }) } };
    });
    expect(response.outcome).toBe('accepted');
    if (response.outcome !== 'accepted' || !('sessionId' in response.result)) throw new Error('Fork did not return a session ID');
    const fork = f.registry.binding(response.result.sessionId)!;
    expect(fork.sessionId).not.toBe(id);
    const history = JSON.stringify(fork.runtime.session.sessionManager.getBranch());
    expect(history).toContain('first'); expect(history).not.toContain('inactive selected'); expect(history).not.toContain('active sibling');
    expect(await readFile(path)).toEqual(before); expect(session.sessionManager.getLeafId()).toBe(leaf);
    expect(f.registry.attachmentCount(id)).toBe(1); expect(f.registry.attachmentCount(fork.sessionId)).toBe(0);
    f.registry.detach(id, attachment.attachment);
  });

  it('rejects missing, empty, non-user and out-of-range fork selections before dispatch', async () => {
    const f = await fixture(); const id = f.root.sessionId;
    await f.root.runtime.session.prompt('only user'); f.registry.projection(id).refresh();
    const assistant = f.root.runtime.session.sessionManager.getBranch().find(entry => entry.type === 'message' && entry.message.role === 'assistant')!;
    for (const from of [{ kind: 'position', position: 3 }, { kind: 'entry', entryId: assistant.id }, { kind: 'entry', entryId: 'absent' }] as const) {
      const request = requestId(); f.store.admit({ v: 1, id: request, op: 'fork', session: id, params: { from } }, 'owner');
      await expect(forkSession(f.registry, request, id, { from })).rejects.toThrow('stored user message');
      expect(f.store.snapshot().requests.find(item => item.id === request)?.phase).toBe('intent');
    }
    const empty = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, model: f.root.runtime.session.model! });
    const request = requestId(); const from = { kind: 'position', position: 0 } as const;
    f.store.admit({ v: 1, id: request, op: 'fork', session: empty.sessionId, params: { from } }, 'owner');
    await expect(forkSession(f.registry, request, empty.sessionId, { from })).rejects.toThrow('stored user message');
  });

  it('starts only a dispatched foreground operation and preserves arbitrary output and stdin bytes', async () => {
    const f = await fixture(); const id = f.root.sessionId; const p = processRuntime(f);
    await expect(f.registry.processes.startForeground(p.request, id, { command: 'synthetic', includeInContext: false })).rejects.toThrow('committed shell dispatch');
    expect(p.start).not.toHaveBeenCalled(); f.store.markDispatched(p.request);
    await expect(f.registry.processes.startForeground(p.request, id, { command: 'different', includeInContext: false })).rejects.toThrow('admitted payload');
    const { resourceId } = await f.registry.processes.startForeground(p.request, id, { command: 'synthetic', includeInContext: false });
    await expect(f.registry.processes.startForeground(p.request, id, { command: 'synthetic', includeInContext: false })).rejects.toThrow('cannot be repeated');
    expect(p.start).toHaveBeenCalledOnce();
    expect(f.store.snapshot().resources.find(row => row.id === resourceId)).toMatchObject({ session: id, root: id, kind: 'foreground' });
    expect(await f.registry.processes.read(id, resourceId, 1, 3)).toEqual({ data: new Uint8Array([255, 3, 13]), offset: 1, nextOffset: 4, state: 'running' });
    const input = new Uint8Array([255, 0, 3, 4, 128]);
    expect(await f.registry.processes.write(id, resourceId, input)).toBe(input.byteLength);
    expect(p.writes).toEqual([input]);
    await f.registry.processes.stopForSession(id, resourceId, 'SIGTERM');
    expect(p.process.terminate).toHaveBeenCalledWith('SIGTERM');
    expect(await f.registry.processes.read(id, resourceId, 0, 64)).toMatchObject({ state: 'exited', exitCode: 0 });
    await expect(f.registry.processes.write(id, resourceId, input)).rejects.toThrow('stdin is unavailable');
  });

  it('bounds process byte ranges, reports discarded offsets and rejects raw-PID or foreign-root access', async () => {
    const f = await fixture(); const id = f.root.sessionId; const p = processRuntime(f); f.store.markDispatched(p.request);
    const { resourceId } = await f.registry.processes.startForeground(p.request, id, { command: 'synthetic', includeInContext: false });
    const other = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, model: f.root.runtime.session.model! });
    await expect(f.registry.processes.read(other.sessionId, resourceId, 0, 1)).rejects.toThrow('authorized session scope');
    await expect(f.registry.processes.read(id, '12345', 0, 1)).rejects.toThrow('authorized session scope');
    await expect(f.registry.processes.read(id, resourceId, 0, 65537)).rejects.toThrow('read range');
    await expect(f.registry.processes.write(id, resourceId, new Uint8Array(16385))).rejects.toThrow('input size');
    vi.mocked(p.process.read).mockResolvedValueOnce({ output: new Uint8Array([1]), nextOffset: 10, running: true });
    await expect(f.registry.processes.read(id, resourceId, 0, 1)).rejects.toMatchObject({ code: 'resync_required' });
    expect(p.process.write).not.toHaveBeenCalled();
  });

  it('authorizes the actual creator lineage, not merely a shared root string', async () => {
    const f = await fixture(); const root = f.root.sessionId;
    const child = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, rootSessionId: root, parentSessionId: root, model: f.root.runtime.session.model! });
    const sibling = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, rootSessionId: root, parentSessionId: root, model: f.root.runtime.session.model! });
    const p = processRuntime(f, child.sessionId); f.store.markDispatched(p.request);
    const { resourceId } = await f.registry.processes.startForeground(p.request, child.sessionId, { command: 'synthetic', includeInContext: false });
    expect(await f.registry.processes.write(root, resourceId, new Uint8Array([1]))).toBe(1);
    expect(await f.registry.processes.write(child.sessionId, resourceId, new Uint8Array([2]))).toBe(1);
    await expect(f.registry.processes.write(sibling.sessionId, resourceId, new Uint8Array([3]))).rejects.toThrow('another session lineage');
  });

  it('reports missing handles and rejects unwired detached byte access without recreating a process', async () => {
    const f = await fixture(); const id = f.root.sessionId;
    for (const kind of ['foreground', 'detached'] as const) f.store.putResource({ id: kind, session: id, root: id, kind, state: 'interrupted', updatedAt: now });
    expect(await f.registry.processes.read(id, 'foreground', 23, 64)).toEqual({ data: new Uint8Array(), offset: 23, nextOffset: 23, state: 'interrupted' });
    await expect(f.registry.processes.read(id, 'detached', 0, 64)).rejects.toThrow('Detached output identity is unavailable');
    await expect(f.registry.processes.write(id, 'detached', new Uint8Array([3]))).rejects.toThrow('stdin is unavailable');
  });

  it('revalidates read and write access after the creator starts draining', async () => {
    const f = await fixture(); const id = f.root.sessionId; const p = processRuntime(f); f.store.markDispatched(p.request);
    const { resourceId } = await f.registry.processes.startForeground(p.request, id, { command: 'synthetic', includeInContext: false });
    const entered = gate(); const release = gate();
    vi.mocked(p.process.read).mockImplementationOnce(async () => {
      entered.resolve(); await release.promise; return { output: new Uint8Array([1]), nextOffset: 1, running: true };
    });
    const read = f.registry.processes.read(id, resourceId, 0, 1); const rejected = expect(read).rejects.toThrow('closed to new work');
    try { await entered.promise; f.registry.processes.seal(id); } finally { release.resolve(); }
    await rejected;
    await expect(f.registry.processes.write(id, resourceId, new Uint8Array([3]))).rejects.toThrow('closed to new work');
    expect(p.process.write).not.toHaveBeenCalled();
  });

  it('uses configured shell settings and records a sanitized tail plus the full owned output file', async () => {
    const f = await fixture(); const id = f.root.sessionId; const p = processRuntime(f); f.store.markDispatched(p.request);
    const text = 'first-line\n' + 'line\u001b[31mred\u001b[0m\r\n'.repeat(20000) + '\0last-line'; p.setOutput(new TextEncoder().encode(text));
    const prepared = f.registry.processes.prepareForeground(id, { shell: '/bin/sh', prefix: 'prefix-line' });
    const { resourceId } = await f.registry.processes.startForeground(p.request, id, { command: 'synthetic', includeInContext: false }, prepared);
    expect(p.start).toHaveBeenCalledWith('prefix-line\nsynthetic', expect.objectContaining({ shell: '/bin/sh' }));
    await p.process.terminate(); const result = await f.registry.processes.waitForeground(id, resourceId);
    expect(result.truncated).toBe(true); expect(result.output.endsWith('last-line')).toBe(true);
    expect(result.output).not.toContain('first-line'); expect(result.output).not.toMatch(/[\u001b\r\0]/u);
    expect(result.fullOutputPath).toBeDefined();
    const full = await readFile(result.fullOutputPath!, 'utf8'); expect(full.startsWith('first-line')).toBe(true); expect(full.endsWith('last-line')).toBe(true);
    expect(full).not.toMatch(/[\u001b\r\0]/u);
  });

  it('reaps the foreground-attempt guard across 4097 sequential completed dispatches without permitting redispatch', async () => {
    const resources = new Map<string, Record<string, unknown>>(); let request: Record<string, unknown> | undefined;
    const session = { id: 'root', root: 'root', state: 'open' };
    const store = { session: () => session, sessionMetadata: () => session, sessionMetadatas: () => [session], request: (id: string) => request?.id === id ? request : undefined,
      resource: (id: string) => resources.get(id), resources: () => [...resources.values()],
      putResource: (row: { id: string }) => { resources.set(row.id, row); return { value: row, revisions: { root: 1 } }; } } as unknown as DaemonControlStore;
    const tracker = new RegistryProcesses({ store, assertCurrent() {}, changed() {} });
    const start = vi.fn(async (): Promise<AgentRuntimeProcess> => ({ pid: undefined,
      read: async offset => ({ output: new Uint8Array(), nextOffset: offset, running: false, exitCode: 0 }),
      write: async () => {}, terminate: async () => {}, dispose: async () => {},
    }));
    tracker.wrap({ kind: 'host', cwd: '/fixture', storage: () => ({ root: '/fixture' }), processes: { startShell: start } } as unknown as AgentRuntime, { session: 'root', root: 'root' });
    for (let index = 0; index < 4097; index++) {
      resources.clear(); const id = requestId(); const params = { command: 'synthetic', includeInContext: false };
      const payload = canonicalRequestPayload({ v: 1, id, op: 'shell.execute', session: 'root', params }, { checkFreshness: false });
      request = { id, op: 'shell.execute', session: 'root', phase: 'dispatch_intent', identity: { bytes: Buffer.byteLength(payload), sha256: createHash('sha256').update(payload).digest('hex') } };
      const { resourceId } = await tracker.startForeground(id, 'root', params);
      await tracker.waitForeground('root', resourceId); request.phase = 'terminal';
      await expect(tracker.startForeground(id, 'root', params)).rejects.toThrow('committed shell dispatch');
    }
    expect(start).toHaveBeenCalledTimes(4097);
  }, 60_000);
});
