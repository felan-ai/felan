import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostAgentRuntime, type AgentRuntime, type AgentRuntimeProcess } from '@felan-ai/agent-core';
import { BackgroundBashManager } from '@felan-ai/ext-background-bash';
import { deferred, fixture, fixtures, supported } from './fixtures/registry.js';

afterEach(async () => { for (const cleanup of fixtures.splice(0)) await cleanup(); });

describe.skipIf(!supported)('registry process ownership', () => {
  it('tracks real coordinator PTY handles and settles them on close, not detach', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    let running = true;
    const terminate = vi.fn(async () => { running = false; });
    const handle: AgentRuntimeProcess = { pid: 4242, read: async () => ({ output: new Uint8Array(), nextOffset: 0, running, ...(running ? {} : { exitCode: 0 }) }),
      write: vi.fn(async () => {}), terminate, dispose: vi.fn(async () => {}) };
    await mkdir(join(f.owner.target.agentDir, 'storage', 'sessions', b.sessionId), { recursive: true });
    await mkdir(join(f.owner.target.agentDir, 'storage', 'agent'), { recursive: true });
    const host = new HostAgentRuntime(f.cwd, { pathAccess: 'host', agentStorageRoot: join(f.owner.target.agentDir, 'storage', 'agent'), sessionStorageRoot: join(f.owner.target.agentDir, 'storage', 'sessions', b.sessionId) });
    const fake = new Proxy(host, { get(target, key) {
      if (key === 'terminals') return { startShell: async () => handle };
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as AgentRuntime;
    const runtime = f.registry.processes.wrap(fake, { session: b.sessionId, root: b.sessionId });
    const manager = new BackgroundBashManager(runtime, f.registry.processes.coordinator(b.sessionId, runtime));
    const { job } = await manager.startInteractive('synthetic pty');
    expect(f.registry.processes.list(b.sessionId)).toEqual([expect.objectContaining({ id: job.meta.id, kind: 'pty', state: 'running', controllable: true })]);
    expect(await f.registry.evictIdle()).toEqual([]);
    const attached = await f.registry.attach(b.sessionId, { principal: 'one', kind: 'tui' });
    f.registry.detach(b.sessionId, attached.attachment);
    expect(terminate).not.toHaveBeenCalled();
    await f.registry.close(b.sessionId);
    expect(terminate).toHaveBeenCalledOnce();
    expect(f.store.snapshot().resources[0]!.state).toBe('exited');
  });

  it('records detached launch identity before the existing bash manager starts its effect', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    await mkdir(join(f.owner.target.agentDir, 'storage', 'sessions', b.sessionId), { recursive: true });
    await mkdir(join(f.owner.target.agentDir, 'storage', 'agent'), { recursive: true });
    const host = new HostAgentRuntime(f.cwd, { pathAccess: 'host', agentStorageRoot: join(f.owner.target.agentDir, 'storage', 'agent'), sessionStorageRoot: join(f.owner.target.agentDir, 'storage', 'sessions', b.sessionId) });
    const shell = vi.fn(async () => {
      expect(f.store.snapshot().resources).toEqual([expect.objectContaining({ kind: 'detached', state: 'running', startIdentity: expect.any(String) })]);
      return { stdout: 'group:4242:4242\n', stderr: '', code: 0, killed: false };
    });
    const fake = new Proxy(host, { get(target, key) {
      if (key === 'shell') return shell;
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as AgentRuntime;
    const runtime = f.registry.processes.wrap(fake, { session: b.sessionId, root: b.sessionId });
    const job = await new BackgroundBashManager(runtime).start('synthetic detached');
    expect(f.store.snapshot().resources[0]).toMatchObject({ id: job.meta.id, kind: 'detached' });
    expect(await f.registry.evictIdle()).toEqual([]);
    await f.registry.close(b.sessionId);
    expect(shell).toHaveBeenCalledOnce();
    expect(f.store.snapshot().resources[0]!.state).toBe('running');
  });

  it('refuses control from persisted PID references without a verified live identity', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    f.store.putResource({ id: 'lost', kind: 'pty', session: b.sessionId, root: b.sessionId, pid: 4242, state: 'missing', updatedAt: Date.now() });
    expect(f.registry.processes.list(b.sessionId)[0]).toMatchObject({ state: 'missing', controllable: false });
    await expect(f.registry.processes.stop(b.sessionId, 'lost')).rejects.toThrow('unverified');
    await expect(f.registry.processes.stop('another-root', 'lost')).rejects.toThrow('not found');
  });

  it('joins outstanding read continuations before close and prevents new effects on retained wrappers', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const gate = deferred(); const terminated = deferred(); f.releases.add(gate.resolve);
    let running = true; let readFinished = false;
    const handle: AgentRuntimeProcess = {
      read: async (_offset, options) => { if (options?.maxBytes === 1) { await gate.promise; readFinished = true; } return { output: new Uint8Array(), nextOffset: 0, running, exitCode: 0 }; },
      terminate: async () => { running = false; terminated.resolve(); }, dispose: async () => {}, write: async () => {},
    };
    const start = vi.fn(async () => handle);
    const runtime = await wrappedRuntime(f, b.sessionId, b.rootSessionId, { processes: { startShell: start } });
    const process = await runtime.processes!.startShell('synthetic');
    const reading = process.read(0, { maxBytes: 1 });
    let closed = false; const close = f.registry.close(b.sessionId).then(() => { closed = true; });
    await terminated.promise; expect(closed).toBe(false); expect(readFinished).toBe(false);
    await expect(runtime.processes!.startShell('must not start during drain')).rejects.toThrow('closed');
    gate.resolve(); await Promise.all([reading, close]);
    const revision = f.store.session(b.sessionId).revision;
    await expect(runtime.processes!.startShell('must not start after close')).rejects.toThrow('closed');
    await expect(runtime.storage().writeFile('after-close', new Uint8Array())).rejects.toThrow('closed');
    expect(start).toHaveBeenCalledOnce(); expect(f.store.session(b.sessionId).revision).toBe(revision);
  });

  it('routes shared-root PTYs to each child creator without stopping a sibling or root', async () => {
    const f = await fixture(); const root = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const child = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, rootSessionId: root.sessionId, parentSessionId: root.sessionId });
    const sibling = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, rootSessionId: root.sessionId, parentSessionId: root.sessionId });
    const handles = new Map<string, { running: boolean; start: ReturnType<typeof vi.fn> }>();
    const managers = new Map<string, BackgroundBashManager>();
    for (const binding of [root, child, sibling]) {
      const state = { running: true, start: vi.fn() };
      const handle: AgentRuntimeProcess = { read: async () => ({ output: new Uint8Array(), nextOffset: 0, running: state.running, exitCode: 0 }),
        terminate: async () => { state.running = false; }, dispose: async () => {}, write: async () => {} };
      state.start.mockImplementation(async () => handle); handles.set(binding.sessionId, state);
      const runtime = await wrappedRuntime(f, binding.sessionId, root.sessionId, { terminals: { startShell: state.start } });
      managers.set(binding.sessionId, new BackgroundBashManager(runtime, f.registry.processes.coordinator(root.sessionId, runtime)));
    }
    await managers.get(child.sessionId)!.startInteractive('child PTY');
    await managers.get(sibling.sessionId)!.startInteractive('sibling PTY');
    expect(handles.get(root.sessionId)!.start).not.toHaveBeenCalled();
    expect(handles.get(child.sessionId)!.start).toHaveBeenCalledOnce();
    expect(handles.get(sibling.sessionId)!.start).toHaveBeenCalledOnce();
    await f.registry.close(child.sessionId);
    expect(handles.get(child.sessionId)!.running).toBe(false);
    expect(handles.get(sibling.sessionId)!.running).toBe(true);
    await managers.get(root.sessionId)!.startInteractive('root still usable');
    expect(handles.get(root.sessionId)!.start).toHaveBeenCalledOnce();
    await f.registry.close(root.sessionId);
    expect(handles.get(sibling.sessionId)!.running).toBe(false);
  });

  it('publishes the same missing state and control affordances committed by reconciliation', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const runtime = await wrappedRuntime(f, b.sessionId, b.rootSessionId, {
      shell: async () => ({ stdout: 'group:4242:4242\n', stderr: '', code: 0, killed: false }),
      exec: async () => ({ stdout: '', stderr: '', code: 1, killed: false }),
    });
    const job = await new BackgroundBashManager(runtime).start('synthetic detached');
    const states: unknown[] = []; f.registry.subscribe(b.sessionId, event => { if ('change' in event && event.change.type === 'process.updated') states.push(event.change.process); });
    await rm(job.meta.infoPath); await f.registry.processes.refresh(b.rootSessionId);
    expect(f.store.snapshot().resources.find(row => row.id === job.meta.id)?.state).toBe('missing');
    expect(f.registry.processes.list(b.rootSessionId)).toContainEqual(expect.objectContaining({ id: job.meta.id, state: 'missing', controllable: false }));
    expect(states.at(-1)).toMatchObject({ id: job.meta.id, state: 'missing', controllable: false });
  });

  for (const kind of ['filesystem', 'storage', 'exec'] as const) {
    it(`retains an idle binding during a tracked ${kind} operation without retaining another root`, async () => {
      const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
      const other = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
      const gate = deferred(); f.releases.add(gate.resolve);
      const runtime = await wrappedRuntime(f, b.sessionId, b.rootSessionId, raw => ({
        writeFile: async () => { await gate.promise; },
        exec: async () => { await gate.promise; return { stdout: '', stderr: '', code: 0, killed: false }; },
        storage: scope => new Proxy(raw.storage(scope), { get(target, key) {
          if (key === 'writeFile') return async () => { await gate.promise; };
          const value: unknown = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
        } }),
      }));
      const pending = kind === 'filesystem' ? runtime.writeFile('synthetic', new Uint8Array())
        : kind === 'storage' ? runtime.storage().writeFile('synthetic', new Uint8Array()) : runtime.exec('synthetic', []);
      expect(await f.registry.evictIdle()).toEqual([other.sessionId]);
      expect(f.instances.get(b.sessionId)!.dispose).not.toHaveBeenCalled();
      expect(f.registry.binding(b.sessionId)).toBe(b);
      gate.resolve(); await pending;
      expect(await f.registry.evictIdle()).toEqual([b.sessionId]);
    });
  }

  it('drains a writer started at the eviction boundary before revoking the binding', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const gate = deferred(); f.releases.add(gate.resolve);
    const runtime = await wrappedRuntime(f, b.sessionId, b.rootSessionId, { writeFile: async () => { await gate.promise; } });
    let pending: Promise<void> | undefined;
    vi.spyOn(f.registry.projection(b.sessionId), 'refresh').mockImplementationOnce(() => { pending = runtime.writeFile('synthetic', new Uint8Array()); });
    let evicted = false; const eviction = f.registry.evictIdle().then(ids => { evicted = true; return ids; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(evicted).toBe(false); expect(f.instances.get(b.sessionId)!.dispose).not.toHaveBeenCalled();
    gate.resolve(); await pending; expect(await eviction).toEqual([b.sessionId]);
    await expect(runtime.writeFile('too late', new Uint8Array())).rejects.toThrow('closed');
  });
});

async function wrappedRuntime(f: Awaited<ReturnType<typeof fixture>>, session: string, root: string, overrides: Partial<AgentRuntime> | ((raw: HostAgentRuntime) => Partial<AgentRuntime>)): Promise<AgentRuntime> {
  const paths = { pathAccess: 'host' as const, agentStorageRoot: join(f.owner.target.agentDir, 'storage', 'agent'), sessionStorageRoot: join(f.owner.target.agentDir, 'storage', 'sessions', root) };
  await mkdir(paths.agentStorageRoot, { recursive: true }); await mkdir(paths.sessionStorageRoot, { recursive: true });
  const raw = new HostAgentRuntime(f.cwd, paths);
  const ports = typeof overrides === 'function' ? overrides(raw) : overrides;
  const runtime = new Proxy(raw, { get(target, key) {
    if (key in ports) return Reflect.get(ports, key);
    const value: unknown = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return f.registry.processes.wrap(runtime, { session, root });
}
