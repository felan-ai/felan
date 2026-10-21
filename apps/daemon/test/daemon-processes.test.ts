import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostAgentRuntime, type AgentRuntime, type AgentRuntimeProcess, type AgentRuntimeStdioProcess } from '@felan-ai/agent-core';
import { LIMITS } from '@felan-ai/session-protocol';
import { DaemonControlStore } from '../src/daemon/control-store.js';
import { RegistryProcesses } from '../src/daemon/processes.js';
import type { SessionRegistry } from '../src/daemon/registry.js';
import { FakeBackgroundProcessProvider as BackgroundBashManager, fakeProcessAdapter } from './fixtures/process-provider.js';
import { deferred, fixture, fixtures, now, requestId, supported } from './fixtures/registry.js';

afterEach(async () => { for (const cleanup of fixtures.splice(0)) await cleanup(); });

describe.skipIf(!supported)('registry process ownership', () => {
  it('evicts idle stdio transports, joining their readers, but retains in-flight writes', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const stopped = deferred(); const written = deferred(); f.releases.add(written.resolve);
    let running = true;
    const snapshot = () => ({ output: new Uint8Array(), nextOffset: 0, running, exitCode: 0 });
    const read = async () => { await stopped.promise; return snapshot(); };
    const handle: AgentRuntimeStdioProcess = {
      pid: 42, read: async () => snapshot(), readStdout: read, readStderr: read,
      write: async () => { await written.promise; }, closeInput: async () => {},
      terminate: vi.fn(async () => { running = false; stopped.resolve(); }), dispose: vi.fn(async () => {}),
    };
    const runtime = await wrappedRuntime(f, b.sessionId, b.rootSessionId, {
      processes: { startShell: async () => handle, startStdio: async () => handle },
    });
    const process = await runtime.processes!.startStdio!('protocol-server', []);
    const readers = Promise.all([process.readStdout(0), process.readStderr(0)]);
    expect(f.registry.processes.blocksEviction(b.rootSessionId)).toBe(false);
    const writing = process.write(new Uint8Array());
    expect(await f.registry.evictIdle()).toEqual([]);
    written.resolve(); await writing;
    expect(await f.registry.evictIdle()).toEqual([b.sessionId]);
    expect(await readers).toEqual([expect.objectContaining({ running: false }), expect.objectContaining({ running: false })]);
    expect(handle.terminate).toHaveBeenCalledOnce(); expect(handle.dispose).toHaveBeenCalledOnce();
    expect(f.store.snapshot().resources).toEqual([expect.objectContaining({ state: 'exited' })]);
  });

  it('allows a stdio consumer to close input after daemon-owned process settlement', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    let running = true;
    const snapshot = () => ({ output: new Uint8Array(), nextOffset: 0, running, exitCode: 0 });
    const handle: AgentRuntimeStdioProcess = {
      pid: 42, read: async () => snapshot(), readStdout: async () => snapshot(), readStderr: async () => snapshot(),
      write: vi.fn(async () => {}), closeInput: vi.fn(async () => {}),
      terminate: vi.fn(async () => { running = false; }), dispose: vi.fn(async () => {}),
    };
    const runtime = await wrappedRuntime(f, b.sessionId, b.rootSessionId, {
      processes: { startShell: async () => handle, startStdio: async () => handle },
    });
    const process = await runtime.processes!.startStdio!('protocol-server', []);
    await process.closeInput();
    expect(handle.closeInput).toHaveBeenCalledOnce();
    await f.registry.processes.settle(b.rootSessionId);
    await expect(process.closeInput()).resolves.toBeUndefined();
    await expect(process.closeInput()).resolves.toBeUndefined();
    await expect(process.dispose()).resolves.toBeUndefined();
    expect(handle.closeInput).toHaveBeenCalledOnce();
    expect(handle.dispose).toHaveBeenCalledOnce();
    expect(() => process.write(new Uint8Array())).toThrow('Process handle is disposed.');
    expect(handle.write).not.toHaveBeenCalled();
  });

  it('forwards filesystem operations without outliving the owning session', async () => {
    const f = await fixture();
    const session = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const runtime = await wrappedRuntime(f, session.sessionId, session.rootSessionId, {});
    await runtime.writeFile('journal', new TextEncoder().encode('entry'), { exclusive: true, noFollow: true });
    const snapshot = await runtime.files!.snapshot('journal', 10);
    expect(snapshot.info.size).toBe(5);
    await runtime.files!.append('journal', new TextEncoder().encode('next'), snapshot.info);
    await f.registry.close(session.sessionId);
    await expect(runtime.files!.inspect('journal')).rejects.toThrow('closed to new work');
    await expect(runtime.files!.snapshot('journal', 10)).rejects.toThrow('closed to new work');
    await expect(runtime.files!.append('journal', new Uint8Array())).rejects.toThrow('closed to new work');
  });

  it('tracks and reads detached output in the directory declared by its provider', async () => {
    const f = await fixture({}, fakeProcessAdapter('process-jobs'));
    const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const runtime = await wrappedRuntime(f, b.sessionId, b.rootSessionId, {
      shell: async () => ({ stdout: '', stderr: '', code: 0, killed: false }),
    });
    const job = await new BackgroundBashManager(runtime, 'process-jobs').start('synthetic detached');
    await runtime.storage().writeFile(job.meta.logPath, new TextEncoder().encode('configured output'));
    expect(f.store.snapshot().resources[0]).toMatchObject({ id: job.meta.id, reference: job.meta.infoPath });
    const output = await f.registry.processes.read(b.sessionId, job.meta.id, 0, 1024);
    expect(new TextDecoder().decode(output.data)).toBe('configured output');
  });

  it('keeps remote job references out of local store ownership, including after recovery', async () => {
    const readOutputRange = vi.fn(async (_runtime: AgentRuntime, _path: string, offset: number, limit: number) =>
      new TextEncoder().encode('remote output').slice(offset, offset + limit));
    const adapter = { ...fakeProcessAdapter(), readOutputRange };
    const f = await fixture({}, adapter);
    const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const remoteRoot = '/remote/workspace/.felan/session';
    const files = new Map<string, Uint8Array>();
    const ports = (raw: HostAgentRuntime): Partial<AgentRuntime> => ({
      kind: 'docker',
      storage: () => ({ ...raw.storage(), root: remoteRoot,
        mkdir: async () => {},
        writeFile: async (path, bytes) => { files.set(path, bytes); },
        readFile: async path => { const bytes = files.get(path); if (!bytes) throw new Error('Missing remote file'); return bytes; },
      }),
      shell: async () => ({ stdout: '', stderr: '', code: 0, killed: false }),
      exec: async () => ({ stdout: '', stderr: '', code: 1, killed: false }),
      terminals: { startShell: async () => ({ pid: 42,
        read: async offset => ({ output: new TextEncoder().encode('hi\n').slice(offset), nextOffset: 3, running: false, exitCode: 0 }),
        write: async () => {}, terminate: async () => {}, dispose: async () => {},
      }) },
    });
    const remote = await wrappedRuntime(f, b.sessionId, b.rootSessionId, ports);
    const manager = new BackgroundBashManager(remote);
    const foreground = await manager.startInteractive('echo hi');
    expect(new TextDecoder().decode((await remote.terminals!.attach!(foreground.job.meta.id)!.read(0)).output)).toBe('hi\n');
    expect(f.registry.processes.list(b.rootSessionId)).toContainEqual(expect.objectContaining({ id: foreground.job.meta.id, kind: 'pty', state: 'exited' }));
    const job = await manager.start('echo remote');
    expect(() => f.owner.assertOwnsPath(job.meta.infoPath)).toThrow('outside the daemon store roots');
    expect(f.store.resource(job.meta.id)?.reference).toBe(job.meta.infoPath);
    expect(new TextDecoder().decode((await f.registry.processes.read(b.sessionId, job.meta.id, 7, 6)).data)).toBe('output');
    expect(readOutputRange).toHaveBeenCalledWith(remote, job.meta.logPath, 7, 6);
    await f.registry.shutdown(); f.store.close();
    const store = new DaemonControlStore(f.owner);
    const registry = f.createRegistry(store); f.replaceRegistry(registry, store);
    expect(store.resource(job.meta.id)?.reference).toBe(job.meta.infoPath);
    const ownRoot = vi.spyOn(f.owner, 'ownRoot');
    await store.ownPersistedRoots();
    expect(ownRoot).not.toHaveBeenCalled();
    const processes = new RegistryProcesses({ store, processAdapter: adapter, assertCurrent: () => f.owner.assertCurrent(), changed() {} });
    await wrappedRuntime(f, b.sessionId, b.rootSessionId, ports, processes);
    expect(new TextDecoder().decode((await processes.read(b.sessionId, job.meta.id, 0, 6)).data)).toBe('remote');
  });

  it('does not read persisted job references outside the provider storage directory', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const readFile = vi.fn();
    await wrappedRuntime(f, b.sessionId, b.rootSessionId, raw => ({ storage: () => ({ ...raw.storage(), readFile }) }));
    f.store.putResource({ id: 'untrusted-job', kind: 'detached', session: b.sessionId, root: b.rootSessionId,
      reference: join(f.owner.target.agentDir, 'unrelated.json'), startIdentity: 'launch', state: 'running', updatedAt: now });
    await f.registry.processes.refresh(b.rootSessionId);
    expect(readFile).not.toHaveBeenCalled();
    await expect(f.registry.processes.read(b.sessionId, 'untrusted-job', 0, 1)).rejects.toThrow('outside its root storage');
  });

  it('snapshots running and most recently updated processes once a root has more than a page', async () => {
    const f = await fixture(); const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const total = LIMITS.pageEntries + 4;
    for (let index = 0; index < total; index++) {
      f.store.putResource({ id: `process-${index}`, session: b.sessionId, root: b.rootSessionId, kind: index === 0 ? 'detached' : 'foreground', state: index === 0 ? 'running' : 'exited', updatedAt: 0 });
    }
    const { snapshot } = await f.registry.attach(b.sessionId, { principal: 'one', kind: 'tui' });
    expect(snapshot.processes.map(item => item.id)).toEqual(['process-0', ...Array.from({ length: total - 5 }, (_, index) => `process-${index + 5}`)]);
  }, 15_000);

  it('reads and stops a detached process using only adapter-owned record metadata', async () => {
    const stopped = vi.fn(async () => {});
    const record = { id: 'worker-42', kind: 'detached' as const, status: 'running' as const,
      command: 'worker', startedAt: Date.now(), startIdentity: 'unique-launch', commandIdentity: ['worker', 'unique-launch'] };
    const adapter = { ...fakeProcessAdapter('workers'), stopDetached: stopped,
      describeJob: (_runtime: AgentRuntime, path: string, bytes: Uint8Array) => path.endsWith('worker.record') && new TextDecoder().decode(bytes) === 'opaque record'
        ? { ...record, outputPath: join(path, '..', 'stream.txt') } : undefined,
      inspectDetached: async () => ({ status: 'running' as const, pid: 42 }),
    };
    const f = await fixture({}, adapter);
    const b = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const runtime = await wrappedRuntime(f, b.sessionId, b.rootSessionId, {
      exec: async () => ({ stdout: 'worker unique-launch', stderr: '', code: 0, killed: false }),
    });
    const storage = runtime.storage(); const directory = join(storage.root, 'workers');
    await storage.mkdir(directory, { recursive: true });
    await storage.writeFile(join(directory, 'worker.record'), new TextEncoder().encode('opaque record'));
    await storage.writeFile(join(directory, 'stream.txt'), new TextEncoder().encode('streamed output'));
    expect(f.registry.processes.list(b.rootSessionId)).toContainEqual(expect.objectContaining({ id: record.id, command: 'worker' }));
    const output = await f.registry.processes.read(b.sessionId, record.id, 0, 1024);
    expect(new TextDecoder().decode(output.data)).toBe('streamed output');
    await f.registry.processes.stop(b.rootSessionId, record.id, 'SIGKILL');
    expect(stopped).toHaveBeenCalledWith(runtime, record.id, 'SIGKILL');
    const restarted = new RegistryProcesses({ store: f.store, processAdapter: adapter,
      assertCurrent: () => f.owner.assertCurrent(), changed() {} });
    restarted.wrap(runtime, { session: b.sessionId, root: b.rootSessionId });
    await restarted.refresh(b.rootSessionId);
    expect(restarted.list(b.rootSessionId)).toContainEqual(expect.objectContaining({ id: record.id, controllable: true }));
    expect(new TextDecoder().decode((await restarted.read(b.sessionId, record.id, 0, 1024)).data)).toBe('streamed output');
  });

  it('exposes root-scoped interactive controls through the runtime without a job format', async () => {
    const f = await fixture(); const root = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    const child = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, rootSessionId: root.sessionId, parentSessionId: root.sessionId });
    const other = await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } });
    let running = true;
    const write = vi.fn(async () => {});
    const handle: AgentRuntimeProcess = {
      pid: 42, read: async () => ({ output: new TextEncoder().encode('output'), nextOffset: 6, running }),
      write, terminate: async () => { running = false; }, dispose: async () => {},
    };
    const runtime = await wrappedRuntime(f, root.sessionId, root.sessionId, { terminals: { startShell: async () => handle } });
    const childRuntime = await wrappedRuntime(f, child.sessionId, root.sessionId, {});
    const otherRuntime = await wrappedRuntime(f, other.sessionId, other.sessionId, {});
    const process = await runtime.terminals!.startShell('worker', { id: 'interactive-worker' });
    expect(process).not.toBe(handle);
    await expect(runtime.terminals!.startShell('worker', { id: 'interactive-worker' })).rejects.toThrow('already registered');
    expect(runtime.terminals!.attach!('interactive-worker')).toBeDefined();
    const attached = await f.registry.attach(root.sessionId, { principal: 'one', kind: 'tui' });
    f.registry.detach(root.sessionId, attached.attachment);
    expect(new TextDecoder().decode((await runtime.terminals!.attach!('interactive-worker')!.read(0)).output)).toBe('output');
    await process.dispose();
    expect(running).toBe(true);
    await process.write(new TextEncoder().encode('input'));
    expect(write).toHaveBeenCalledWith(new TextEncoder().encode('input'));
    expect(new TextDecoder().decode((await childRuntime.terminals!.attach!('interactive-worker')!.read(0)).output)).toBe('output');
    expect(otherRuntime.terminals!.attach!('interactive-worker')).toBeUndefined();
    await process.terminate();
    expect(running).toBe(false);
    expect(await childRuntime.terminals!.attach!('interactive-worker')!.read(0)).toMatchObject({ signal: 'SIGTERM', running: false });
  });

  it('tracks addressable PTY handles and settles them on close, not detach', async () => {
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
    const manager = new BackgroundBashManager(runtime);
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
      managers.set(binding.sessionId, new BackgroundBashManager(runtime));
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

  it('keeps detached and PTY processes running and controllable across reload; only the PTY is restart-interruptible work', async () => {
    const stopDetached = vi.fn(async () => {});
    const f = await fixture({}, { ...fakeProcessAdapter(), inspectDetached: async () => ({ status: 'running' as const, pid: 42 }), stopDetached });
    const root = (await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } })).sessionId;
    const pty = syntheticTerminal(); let identity = '';
    const ports = { terminals: { startShell: async () => pty.handle }, shell: async () => ({ stdout: '', stderr: '', code: 0, killed: false }),
      exec: async () => ({ stdout: identity, stderr: '', code: 0, killed: false }) };
    const before = await wrappedRuntime(f, root, root, ports);
    const manager = new BackgroundBashManager(before);
    const { job: terminal } = await manager.startInteractive('synthetic pty');
    const detached = await manager.start('synthetic detached'); identity = `${detached.meta.runnerPath} ${detached.meta.processToken}`;
    await before.storage().writeFile(detached.meta.logPath, new TextEncoder().encode('detached output'));
    expect(f.registry.processes.activeCount(root)).toBe(2);
    expect(await f.registry.activeWork()).toBe(1);

    const reload = requestId(); f.store.admit({ v: 1, id: reload, op: 'session.reload', session: root, params: {} }, 'client');
    await f.registry.reloadAdmitted(reload, root);
    expect(pty.handle.terminate).not.toHaveBeenCalled(); expect(pty.handle.dispose).not.toHaveBeenCalled();
    expect(() => before.terminals!.attach!(terminal.meta.id)).toThrow('closed');
    const after = await wrappedRuntime(f, root, root, ports);
    expect(f.registry.processes.list(root)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: terminal.meta.id, kind: 'pty', state: 'running', controllable: true }),
      expect.objectContaining({ id: detached.meta.id, kind: 'detached', state: 'running' }),
    ]));
    const attached = after.terminals!.attach!(terminal.meta.id)!;
    expect(new TextDecoder().decode((await attached.read(0)).output)).toBe('pty output');
    await attached.write(new TextEncoder().encode('attached'));
    await f.registry.processes.write(root, terminal.meta.id, new TextEncoder().encode('protocol'));
    expect(pty.handle.write).toHaveBeenCalledTimes(2);
    expect(new TextDecoder().decode((await f.registry.processes.read(root, detached.meta.id, 0, 1024)).data)).toBe('detached output');
    await f.registry.processes.stopForSession(root, terminal.meta.id, 'SIGTERM');
    expect(pty.handle.terminate).toHaveBeenCalledOnce();
    await f.registry.processes.prepareStop(root, detached.meta.id);
    await f.registry.processes.stopForSession(root, detached.meta.id, 'SIGTERM');
    expect(stopDetached).toHaveBeenCalledWith(after, detached.meta.id, 'SIGTERM');
    expect(await f.registry.activeWork()).toBe(0);
  });

  it('stops counting a kept PTY as active work once it exits unread after reload', async () => {
    const f = await fixture(); const root = (await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } })).sessionId;
    const pty = syntheticTerminal();
    const { job } = await new BackgroundBashManager(await wrappedRuntime(f, root, root, { terminals: { startShell: async () => pty.handle } })).startInteractive('synthetic pty');
    const reload = requestId(); f.store.admit({ v: 1, id: reload, op: 'session.reload', session: root, params: {} }, 'client');
    await f.registry.reloadAdmitted(reload, root);
    expect(await f.registry.activeWork()).toBe(1);
    await pty.handle.terminate();
    expect(await f.registry.activeWork()).toBe(0);
    expect(f.registry.processes.list(root)).toEqual([expect.objectContaining({ id: job.meta.id, state: 'exited', controllable: false })]);
  });

  it('settles PTYs kept by a failed reload when the daemon shuts down', async () => {
    const f = await fixture(); const root = (await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } })).sessionId;
    const pty = syntheticTerminal();
    const { job } = await new BackgroundBashManager(await wrappedRuntime(f, root, root, { terminals: { startShell: async () => pty.handle } })).startInteractive('synthetic pty');
    vi.mocked(f.profile.openSession).mockRejectedValueOnce(new Error('reload failed'));
    const reload = requestId(); f.store.admit({ v: 1, id: reload, op: 'session.reload', session: root, params: {} }, 'client');
    await expect(f.registry.reloadAdmitted(reload, root)).rejects.toThrow('reload failed');
    expect(f.registry.binding(root)).toBeUndefined(); expect(pty.handle.terminate).not.toHaveBeenCalled();
    await f.registry.shutdown();
    expect(pty.handle.terminate).toHaveBeenCalledOnce(); expect(pty.handle.dispose).toHaveBeenCalledOnce();
    expect(f.store.snapshot().resources).toEqual([expect.objectContaining({ id: job.meta.id, state: 'exited' })]);
  });

  it('lets the root control a PTY started by a child after reload disposes the idle child', async () => {
    const f = await fixture(); const root = (await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } })).sessionId;
    const child = (await f.registry.create({ cwd: f.cwd, target: { kind: 'new' }, rootSessionId: root, parentSessionId: root })).sessionId;
    const pty = syntheticTerminal();
    const { job } = await new BackgroundBashManager(await wrappedRuntime(f, child, root, { terminals: { startShell: async () => pty.handle } })).startInteractive('child pty');
    const reload = requestId(); f.store.admit({ v: 1, id: reload, op: 'session.reload', session: root, params: {} }, 'client');
    await f.registry.reloadAdmitted(reload, root);
    expect(f.registry.binding(child)).toBeUndefined(); expect(pty.handle.terminate).not.toHaveBeenCalled();
    await wrappedRuntime(f, root, root, {});
    expect(new TextDecoder().decode((await f.registry.processes.read(root, job.meta.id, 0, 1024)).data)).toBe('pty output');
    await f.registry.processes.write(root, job.meta.id, new TextEncoder().encode('from root'));
    expect(pty.handle.write).toHaveBeenCalledWith(new TextEncoder().encode('from root'));
    await f.registry.processes.stopForSession(root, job.meta.id, 'SIGTERM');
    expect(pty.handle.terminate).toHaveBeenCalledOnce();
  });

  it('propagates a store failure from restore reconciliation and fences the registry', async () => {
    const f = await fixture(); const root = (await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } })).sessionId;
    expect(await f.registry.evictIdle()).toEqual([root]);
    f.store.putResource({ id: 'stale-pty', kind: 'pty', session: root, root, state: 'running', updatedAt: now });
    const commit = vi.spyOn(f.store, 'putResource').mockImplementation(() => { throw new Error('commit failed'); });
    await expect(f.registry.restore(root)).rejects.toThrow('commit failed');
    commit.mockRestore();
    expect(() => f.registry.assertAdmission()).toThrow('not admitting');
    await f.registry.settleWriters().catch(() => {}); f.replaceRegistry(undefined as never, f.store);
  });

  it('keeps restoring when one detached process cannot be inspected', async () => {
    const adapter = { ...fakeProcessAdapter(), inspectDetached: vi.fn(async () => { throw new Error('inspection failed'); }) };
    const f = await fixture({}, adapter); const root = (await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } })).sessionId;
    const ports = { shell: async () => ({ stdout: '', stderr: '', code: 0, killed: false }) };
    const detached = await new BackgroundBashManager(await wrappedRuntime(f, root, root, ports)).start('synthetic detached');
    await f.registry.close(root);
    openWrappedRoots(f, () => f.registry, ports);
    await f.registry.restore(root);
    expect(adapter.inspectDetached).toHaveBeenCalled();
    expect(f.store.snapshot().resources).toEqual([expect.objectContaining({ id: detached.meta.id, state: 'running' })]);
    expect(() => f.registry.assertAdmission()).not.toThrow();
  });

  it('ends PTYs with the daemon but leaves detached jobs running for the restarted daemon to rediscover and control', async () => {
    const stopDetached = vi.fn(async () => {});
    const adapter = { ...fakeProcessAdapter(), inspectDetached: async () => ({ status: 'running' as const, pid: 42 }), stopDetached };
    const f = await fixture({}, adapter);
    const root = (await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } })).sessionId;
    const pty = syntheticTerminal(); let identity = '';
    const ports = { terminals: { startShell: async () => pty.handle }, shell: async () => ({ stdout: '', stderr: '', code: 0, killed: false }),
      exec: async () => ({ stdout: identity, stderr: '', code: 0, killed: false }) };
    const runtime = await wrappedRuntime(f, root, root, ports);
    const manager = new BackgroundBashManager(runtime);
    const { job: terminal } = await manager.startInteractive('synthetic pty');
    const detached = await manager.start('synthetic detached'); identity = `${detached.meta.runnerPath} ${detached.meta.processToken}`;
    await runtime.storage().writeFile(detached.meta.logPath, new TextEncoder().encode('detached output'));

    await f.registry.shutdown();
    expect(pty.handle.terminate).toHaveBeenCalledOnce(); expect(stopDetached).not.toHaveBeenCalled();
    f.store.close(); const store = new DaemonControlStore(f.owner, { now: () => now });
    const registry = f.createRegistry(store); f.replaceRegistry(registry, store);
    openWrappedRoots(f, () => registry, ports);
    await registry.restore(root);
    const restarted = registry.binding(root)!.agentRuntime;
    expect(registry.processes.list(root)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: terminal.meta.id, state: 'exited', controllable: false }),
      expect.objectContaining({ id: detached.meta.id, state: 'running', controllable: true, command: 'synthetic detached' }),
    ]));
    expect(await registry.activeWork()).toBe(0);
    expect(new TextDecoder().decode((await registry.processes.read(root, detached.meta.id, 0, 1024)).data)).toBe('detached output');
    await registry.processes.stopForSession(root, detached.meta.id, 'SIGKILL');
    expect(stopDetached).toHaveBeenCalledWith(restarted, detached.meta.id, 'SIGKILL');
  });

  it('marks a live-process record left running by a previous daemon as interrupted', async () => {
    const f = await fixture(); const root = (await f.registry.create({ cwd: f.cwd, target: { kind: 'new' } })).sessionId;
    f.store.putResource({ id: 'stale-pty', kind: 'pty', session: root, root, state: 'running', updatedAt: now });
    await f.registry.processes.refresh(root);
    expect(f.registry.processes.list(root)).toEqual([expect.objectContaining({ id: 'stale-pty', state: 'interrupted', controllable: false })]);
    expect(f.registry.processes.activeCount(root)).toBe(0);
  });

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

function syntheticTerminal() {
  let running = true;
  const handle = { pid: 4242, read: async (offset: number) => offset === 0
    ? { output: new TextEncoder().encode('pty output'), nextOffset: 10, running, ...(running ? {} : { exitCode: 0 }) }
    : { output: new Uint8Array(), nextOffset: offset, running, ...(running ? {} : { exitCode: 0 }) },
  write: vi.fn(async () => {}), terminate: vi.fn(async () => { running = false; }), dispose: vi.fn(async () => {}) } satisfies AgentRuntimeProcess;
  return { handle };
}

/** Gives every opened session the root's wrapped host runtime, so restore reconciliation sees it like production composition does. */
function openWrappedRoots(f: Awaited<ReturnType<typeof fixture>>, registry: () => SessionRegistry, ports: Partial<AgentRuntime>): void {
  const open = f.profile.openSession;
  f.profile.openSession = async request => {
    const binding = await open(request);
    const paths = { pathAccess: 'host' as const, agentStorageRoot: join(f.owner.target.agentDir, 'storage', 'agent'), sessionStorageRoot: join(f.owner.target.agentDir, 'storage', 'sessions', binding.rootSessionId) };
    await mkdir(paths.agentStorageRoot, { recursive: true }); await mkdir(paths.sessionStorageRoot, { recursive: true });
    const agentRuntime = registry().wrapOpeningRuntime(withPorts(new HostAgentRuntime(f.cwd, paths), ports), binding.rootSessionId);
    await request.services.extensions.bind({ sessionManager: binding.runtime.session.sessionManager, rootSessionId: binding.rootSessionId } as never, {} as never);
    return { ...binding, agentRuntime };
  };
}

function withPorts(raw: HostAgentRuntime, ports: Partial<AgentRuntime>): AgentRuntime {
  return new Proxy(raw, { get(target, key) {
    if (key in ports) return Reflect.get(ports, key);
    const value: unknown = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
}

async function wrappedRuntime(f: Awaited<ReturnType<typeof fixture>>, session: string, root: string, overrides: Partial<AgentRuntime> | ((raw: HostAgentRuntime) => Partial<AgentRuntime>), processes = f.registry.processes): Promise<AgentRuntime> {
  const paths = { pathAccess: 'host' as const, agentStorageRoot: join(f.owner.target.agentDir, 'storage', 'agent'), sessionStorageRoot: join(f.owner.target.agentDir, 'storage', 'sessions', root) };
  await mkdir(paths.agentStorageRoot, { recursive: true }); await mkdir(paths.sessionStorageRoot, { recursive: true });
  const raw = new HostAgentRuntime(f.cwd, paths);
  return processes.wrap(withPorts(raw, typeof overrides === 'function' ? overrides(raw) : overrides), { session, root });
}
