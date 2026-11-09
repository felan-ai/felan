import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { HostAgentRuntime, SessionManager, SettingsManager, type HostWorkerOptions } from '@felan-ai/agent-core';
import { createHostMaintenance } from '../src/daemon/maintenance.js';
import type { HostWorkers } from '../src/daemon/host-workers.js';
import { createRuntimeStorageRequest } from '../src/runtime-factory.js';
import { assistant, fixtures, offlineModel } from './fixtures/registry.js';
import { createTestSessionLifecycle, createTestSessionRuntime } from './fixtures/session-runtime.js';
import { gate, serverFixture } from './fixtures/server.js';
import { TestHostConfiguration } from './fixtures/host-services.js';

afterEach(async () => { for (const cleanup of fixtures.splice(0)) await cleanup(); });

async function fixture(options: Parameters<typeof serverFixture>[0] = {}) {
  const f = await serverFixture(options);
  const identities: unknown[] = []; const wrapped = vi.fn();
  const lifecycle = await createTestSessionLifecycle({ agentDir: f.owner.target.agentDir,
    composition: { ...createTestSessionRuntime(), wrapWorkerStream: identity => {
      identities.push(identity);
      return original => (...args) => { wrapped(); return original(...args); };
    } },
    wrapRuntime: (runtime, request) => f.registry.wrapOpeningRuntime(runtime, request.rootSessionId),
  });
  f.registry.options.lifecycle = lifecycle;
  fixtures.push(async () => { await f.dispose(); await lifecycle.dispose(); });
  const models = f.root.runtime.session.modelRuntime;
  await f.registry.close(f.root.sessionId);
  const configuration = new TestHostConfiguration({ definitions: [], assertCurrent() {} });
  const maintenance = createHostMaintenance();
  maintenance.bind({ registry: f.registry, agentDir: f.owner.target.agentDir, modelRuntime: models, configuration });
  f.registry.options.onShutdown = () => maintenance.close();
  const open = maintenance.service.openWorker;
  async function request(input: { cwd?: string; sessionDir?: string; allowedTools?: string[] } = {}): Promise<HostWorkerOptions> {
    const cwd = input.cwd ?? join(f.root.resources.agentStorageRoot, 'memory', 'staging');
    const sessionDir = input.sessionDir ?? join(f.root.resources.sessionDir, 'memory');
    await mkdir(cwd, { recursive: true }); await mkdir(sessionDir, { recursive: true });
    const created = SessionManager.create(f.cwd, sessionDir);
    await writeFile(created.getSessionFile()!, JSON.stringify(created.getHeader()) + '\n');
    const sessionManager = SessionManager.open(created.getSessionFile()!, sessionDir, f.cwd);
    return { runtime: new HostAgentRuntime(cwd, createRuntimeStorageRequest(cwd, f.owner.target.agentDir, sessionManager.getSessionId())),
      sessionManager, settingsManager: SettingsManager.create(cwd, f.owner.target.agentDir), model: offlineModel,
      allowedTools: input.allowedTools ?? ['read', 'write', 'edit', 'ls', 'grep'] };
  }
  return { ...f, models, open, request, identities, wrapped, maintenance, configuration };
}

describe('daemon host workers', () => {
  it('opens with no resident root, wraps file I/O and inference, and never registers a session', async () => {
    const f = await fixture(); const request = await f.request(); const id = request.sessionManager.getSessionId();
    const listed = f.registry.listed();
    expect(f.registry.binding(f.root.sessionId)).toBeUndefined();
    const resolveModel = vi.spyOn(f.models, 'getAvailable');
    const open = vi.spyOn(f.registry, 'openHostWorker');
    const wrap = vi.spyOn(f.registry.processes, 'wrap');
    const worker = await f.open({ ...request, model: { provider: offlineModel.provider, id: offlineModel.id } });
    const binding = await open.mock.results[0]!.value;
    expect(resolveModel).toHaveBeenCalledWith(offlineModel.provider, { signal: expect.any(AbortSignal) });
    expect(request.sessionManager.getCwd()).toBe(f.cwd);
    expect(request.runtime.cwd).not.toBe(f.cwd);
    expect(binding.resources.cwd).toBe(f.cwd);
    expect(binding.rootSessionId).toBe(id); expect(binding.parentSessionId).toBeUndefined();
    expect(f.identities).toEqual([{ id, root: id }]);
    expect(binding.agentRuntime).not.toBe(request.runtime);
    expect(wrap).toHaveBeenCalledWith(request.runtime, { session: id, root: id });
    const content = new TextEncoder().encode('host worker artifact');
    await binding.agentRuntime.writeFile('artifact.txt', content);
    expect(await binding.agentRuntime.readFile('artifact.txt')).toEqual(content);
    expect(worker.getActiveToolNames().sort()).toEqual([...request.allowedTools].sort());
    expect(() => worker.setActiveToolsByName(['bash'])).toThrow('cannot widen');
    const admission = vi.spyOn(f.registry, 'assertHostWork');
    await worker.prompt('Inspect the staged artifact.');
    expect(admission).toHaveBeenCalledOnce();
    expect(f.wrapped).toHaveBeenCalledOnce();
    expect(worker.messages.length).toBeGreaterThan(0);
    expect(f.registry.listed()).toEqual(listed);
    expect(f.store.findSessionMetadata(id)).toBeUndefined();
    expect(await f.registry.legacySessions(undefined, true)).not.toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
    expect(() => f.registry.restore(id)).toThrow('not registered');
    expect(await f.registry.evictIdle()).not.toContain(id);
    const cleanup = vi.spyOn(f.registry.processes, 'withCleanup');
    const settle = vi.spyOn(f.registry.processes, 'settle');
    const revoke = vi.spyOn(f.registry.processes, 'revoke');
    const revokeRuntime = vi.spyOn(f.registry.processes, 'revokeRuntime');
    await worker.dispose(); await worker.dispose();
    expect(cleanup).toHaveBeenCalledWith(id, expect.any(Function));
    expect(settle).toHaveBeenCalledWith(id);
    expect(revoke).toHaveBeenCalledWith(id);
    expect(revokeRuntime).toHaveBeenCalledWith(binding.agentRuntime);
    await expect(binding.agentRuntime.readFile('artifact.txt')).rejects.toThrow('Session runtime is closed to new work.');
    await expect(binding.agentRuntime.writeFile('artifact.txt', content)).rejects.toThrow('Session runtime is closed to new work.');
    await expect(worker.prompt('Cannot run after disposal.')).rejects.toMatchObject({ name: 'AbortError' });
    await expect(f.open(request)).rejects.toThrow('fresh identity');
    expect(await f.registry.activeWork()).toBe(0);
  });

  it.each(['drain', 'shutdown'] as const)('joins in-flight prompts and aborts them on %s', async action => {
    const stream = gate(); const entered = gate();
    const f = await fixture({ onStream: async () => { entered.resolve(); await stream.promise; } });
    const request = await f.request(); const open = vi.spyOn(f.registry, 'openHostWorker');
    const worker = await f.open(request); const binding = await open.mock.results[0]!.value;
    const originalAbort = binding.runtime.session.abort.bind(binding.runtime.session);
    const abort = vi.spyOn(binding.runtime.session, 'abort').mockImplementation(async () => {
      expect(f.maintenance.service.signal.aborted).toBe(action === 'shutdown');
      await originalAbort();
    });
    const prompt = worker.prompt('Keep working.');
    const rejected = expect(prompt).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise;
    expect(await f.registry.activeWork()).toBe(0);
    let settled = false;
    const stopping = action === 'drain'
      ? (f.registry.beginDrain(), f.registry.waitForDrain())
      : f.registry.shutdown({ interrupt: true });
    const finished = stopping.then(() => { settled = true; });
    await vi.waitFor(() => expect(abort).toHaveBeenCalled());
    expect(f.maintenance.service.signal.aborted).toBe(action === 'shutdown');
    expect(settled).toBe(false);
    await expect(worker.prompt('No new work.')).rejects.toMatchObject({ name: 'AbortError' });
    stream.resolve(); await rejected; await finished;
    expect(await f.registry.activeWork()).toBe(0);
    if (action === 'drain') {
      f.registry.endDrain(); await worker.dispose();
    }
    await expect(binding.agentRuntime.readFile('artifact.txt')).rejects.toThrow('Session runtime is closed to new work.');
  });

  it.each(['global', 'project'] as const)('pins transcript storage despite a %s session directory setting', async scope => {
    const f = await fixture(); const request = await f.request();
    const redirected = join(f.directory, 'configured-sessions');
    const settingsPath = scope === 'global' ? join(f.owner.target.agentDir, 'settings.json') : join(f.cwd, '.pi', 'settings.json');
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ sessionDir: redirected }));
    expect(SettingsManager.create(f.cwd, f.owner.target.agentDir).getSessionDir()).toBe(redirected);
    const resolve = vi.spyOn(f.registry.options.lifecycle, 'resolveResources');
    const ownRoot = vi.spyOn(f.owner, 'ownRoot');
    const worker = await f.open(request);
    expect(resolve).toHaveBeenCalledWith({ cwd: f.cwd, sessionDir: dirname(request.sessionManager.getSessionFile()!) });
    expect(ownRoot).not.toHaveBeenCalled();
    await worker.prompt('Read the staged artifact.');
    await worker.dispose();
  });

  it('keeps maintenance usable after a cancelled drain and opens another worker', async () => {
    const f = await fixture();
    const worker = await f.open(await f.request());
    f.registry.beginDrain();
    expect(f.maintenance.service.signal.aborted).toBe(false);
    const request = await f.request();
    expect(() => f.open(request)).toThrow(expect.objectContaining({ name: 'AbortError', message: 'Daemon is draining.' }));
    await f.registry.waitForDrain();
    f.registry.endDrain();
    await expect(f.maintenance.service.allowedModels()).resolves.toBeUndefined();
    expect(f.maintenance.service.sessions({ kind: 'all' })).toBeDefined();
    const next = await f.open(request);
    await next.prompt('Work after the cancelled drain.');
    await worker.dispose(); await next.dispose();
  });

  it.each(['scope', 'model'] as const)('rejects a pre-drain opening after a cancelled drain during %s resolution', async phase => {
    const f = await fixture(); const request = await f.request();
    const entered = gate(); const release = gate();
    if (phase === 'scope') {
      const get = f.configuration.get.bind(f.configuration);
      vi.spyOn(f.configuration, 'get').mockImplementationOnce(async scope => { entered.resolve(); await release.promise; return get(scope); });
    } else {
      const get = f.models.getAvailable.bind(f.models);
      vi.spyOn(f.models, 'getAvailable').mockImplementationOnce(async (...args) => { entered.resolve(); await release.promise; return get(...args); });
    }
    const open = vi.spyOn(f.registry, 'openHostWorker');
    const pending = f.open(request);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise;
    f.registry.beginDrain(); await f.registry.waitForDrain(); f.registry.endDrain();
    expect(f.maintenance.service.signal.aborted).toBe(false);
    release.resolve(); await rejected;
    expect(open).not.toHaveBeenCalled();
    const next = await f.open(request); await next.dispose();
  });

  it('keeps interrupted prompts cancelled when admission resumes before they settle', async () => {
    const stream = gate(); const entered = gate();
    const f = await fixture({ onStream: async () => { entered.resolve(); await stream.promise; } });
    const worker = await f.open(await f.request());
    const prompt = worker.prompt('Wait for cancellation.');
    const rejected = expect(prompt).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise;
    f.registry.beginDrain(); f.registry.endDrain();
    await expect(worker.prompt('Still cancelling.')).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.maintenance.service.signal.aborted).toBe(false);
    stream.resolve(); await rejected;
    await worker.dispose();
    const next = await f.open(await f.request());
    await next.prompt('Work after cancellation.'); await next.dispose();
  });

  it.each(['drain', 'shutdown', 'compaction'] as const)('joins prompt authentication during %s without starting inference', async action => {
    const f = await fixture(); const open = vi.spyOn(f.registry, 'openHostWorker');
    const request = await f.request();
    if (action === 'compaction') {
      vi.spyOn(request.settingsManager, 'getCompactionSettings').mockReturnValue({ enabled: true, reserveTokens: 1024, keepRecentTokens: 128 });
      for (let index = 0; index < 3; index++) {
        request.sessionManager.appendMessage({ role: 'user', content: 'Previous evidence. '.repeat(1000), timestamp: Date.now() });
        const message = assistant('Previous summary. '.repeat(100));
        message.usage.input = 8000; message.usage.totalTokens = 8001;
        request.sessionManager.appendMessage(message);
      }
    }
    const original = f.registry.openHostWorker.bind(f.registry);
    let originalStream: unknown;
    open.mockImplementationOnce(async input => { const binding = await original(input); originalStream = binding.runtime.session.agent.streamFunction; return binding; });
    const worker = await f.open(request); const binding = await open.mock.results[0]!.value;
    expect(binding.runtime.session.agent.streamFunction).toBe(originalStream);
    const compaction = vi.fn();
    worker.subscribe(event => { if (event.type === 'compaction_start') compaction(); });
    const entered = gate(); const release = gate();
    vi.spyOn(f.models, 'hasConfiguredAuth').mockReturnValue(false);
    vi.spyOn(f.models, 'checkAuth').mockImplementation(async () => { entered.resolve(); await release.promise; return 'fixture'; });
    const rejected = expect(worker.prompt('Wait for authentication.')).rejects.toMatchObject({ name: 'AbortError' });
    try {
      await entered.promise;
      expect(binding.runtime.session.isIdle).toBe(true);
      await expect(worker.prompt('No overlapping preflight.')).rejects.toMatchObject({ code: 'busy' });
      let settled = false;
      const stopping = (action === 'drain' ? (f.registry.beginDrain(), f.registry.waitForDrain())
        : f.registry.shutdown()).then(() => { settled = true; });
      await new Promise(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      release.resolve(); await rejected; await stopping;
      expect(f.wrapped).not.toHaveBeenCalled();
      if (action === 'compaction') expect(compaction).toHaveBeenCalled();
      if (action === 'drain') { f.registry.endDrain(); await worker.dispose(); }
      await expect(binding.agentRuntime.readFile('artifact.txt')).rejects.toThrow('Session runtime is closed to new work.');
    } finally { release.resolve(); }
  });

  it('rejects unsafe tools, workspaces, transcripts, and reused identities', async () => {
    const f = await fixture();
    await expect(f.open(await f.request({ allowedTools: ['bash'] }))).rejects.toThrow('staged-artifact policy');
    await expect(f.open(await f.request({ allowedTools: ['find'] }))).rejects.toThrow('staged-artifact policy');
    await expect(f.open(await f.request({ cwd: f.cwd }))).rejects.toThrow('managed staging storage');
    await expect(f.open(await f.request({ sessionDir: join(f.directory, 'outside-sessions') }))).rejects.toThrow('outside the host session directory');
    const request = await f.request();
    await expect(f.open({ ...request, sessionManager: f.root.runtime.session.sessionManager })).rejects.toThrow();
    const worker = await f.open(request);
    await expect(f.open(request)).rejects.toThrow('fresh identity');
    await worker.dispose();
  });

  it('claims a transcript against another host worker and a registered session', async () => {
    const f = await fixture(); const request = await f.request();
    const worker = await f.open(request);
    const other = await f.request();
    vi.spyOn(other.sessionManager, 'getSessionFile').mockReturnValue(request.sessionManager.getSessionFile());
    await expect(f.open(other)).rejects.toMatchObject({ code: 'busy', message: 'Session transcript already has a writer.' });
    const lifecycle = f.registry.options.lifecycle; const open = lifecycle.openSession.bind(lifecycle);
    vi.spyOn(lifecycle, 'openSession').mockImplementationOnce(input => open({ ...input,
      target: { kind: 'resume', sessionFile: request.sessionManager.getSessionFile()! } }));
    await expect(f.registry.create({ cwd: f.cwd, target: { kind: 'new' } })).rejects.toThrow('writer');
    await worker.dispose();
  });

  it.each(['cwd', 'roots', 'callback roots', 'callback identity'] as const)('rejects inconsistent %s during setup', async change => {
    const f = await fixture(); const request = await f.request(); const lifecycle = f.registry.options.lifecycle;
    if (change === 'cwd' || change === 'roots') {
      const resolve = lifecycle.resolveResources.bind(lifecycle);
      vi.spyOn(lifecycle, 'resolveResources').mockImplementationOnce(async input => ({ ...await resolve(input),
        ...(change === 'cwd' ? { cwd: join(f.directory, 'other') } : { writableRoots: ['/outside-owned-storage'] }) }));
    } else {
      vi.spyOn(lifecycle, 'openSession').mockImplementationOnce(async input => {
        await input.ownership.assertOwned({ ...input.resources,
          ...(change === 'callback roots' ? { writableRoots: ['/outside-owned-storage'] } : {}) }, {
          kind: 'resume', destinationDirectory: input.resources.sessionDir,
          sourceSessionFile: request.sessionManager.getSessionFile()!,
          sourceSessionId: change === 'callback identity' ? 'changed' : request.sessionManager.getSessionId(),
        });
        throw new Error('Invalid ownership was accepted.');
      });
    }
    await expect(f.open(request)).rejects.toThrow(change === 'cwd' ? 'does not match' : change === 'callback identity' ? 'identity changed' : 'Outside private server fixture');
  });

  it.each(['session', 'root', 'parent', 'transcript', 'cwd'] as const)('revokes a binding with inconsistent returned %s', async change => {
    const f = await fixture(); const request = await f.request(); const lifecycle = f.registry.options.lifecycle;
    const open = lifecycle.openSession.bind(lifecycle);
    let binding: Awaited<ReturnType<typeof open>> | undefined;
    vi.spyOn(lifecycle, 'openSession').mockImplementationOnce(async input => {
      binding = await open(input);
      if (change === 'transcript') vi.spyOn(request.sessionManager, 'getSessionFile').mockReturnValue('/changed');
      if (change === 'cwd') vi.spyOn(request.sessionManager, 'getCwd').mockReturnValue('/changed');
      return { ...binding, ...(change === 'session' ? { sessionId: 'changed' } : {}),
        ...(change === 'root' ? { rootSessionId: 'changed' } : {}), ...(change === 'parent' ? { parentSessionId: 'changed' } : {}) };
    });
    await expect(f.open(request)).rejects.toThrow('inconsistent worker identity');
    await expect(binding!.agentRuntime.readFile('artifact.txt')).rejects.toThrow('Session runtime is closed to new work.');
  });

  it('rejects unavailable models and cancellation without leaving a live worker', async () => {
    const f = await fixture(); const request = await f.request();
    const resolveModel = vi.spyOn(f.models, 'getAvailable').mockResolvedValueOnce([]);
    await expect(f.open(request)).rejects.toThrow('unavailable');
    resolveModel.mockRestore();
    const cancellation = new AbortController(); cancellation.abort();
    await expect(f.open({ ...request, signal: cancellation.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const original = f.registry.openHostWorker.bind(f.registry); const cancelled = new AbortController();
    vi.spyOn(f.registry, 'openHostWorker').mockImplementationOnce(async worker => { const binding = await original(worker); cancelled.abort(); return binding; });
    await expect(f.open({ ...request, signal: cancelled.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await f.registry.activeWork()).toBe(0);
    expect(f.store.findSessionMetadata(request.sessionManager.getSessionId())).toBeUndefined();
    await expect(f.registry.runWorker(request.sessionManager.getSessionId(), async () => {})).rejects.toThrow('closed');
  });

  it.each(['scope', 'model', 'open', 'activate'] as const)('normalizes a fenced %s failure to AbortError', async phase => {
    const f = await fixture(); const request = await f.request();
    const entered = gate(); const release = gate();
    const fail = async () => { entered.resolve(); await release.promise; throw new Error('Session runtime is closed to new work.'); };
    if (phase === 'scope') vi.spyOn(f.configuration, 'get').mockImplementationOnce(fail);
    else if (phase === 'model') vi.spyOn(f.models, 'getAvailable').mockImplementationOnce(fail);
    else {
      const lifecycle = f.registry.options.lifecycle; const open = lifecycle.openSession.bind(lifecycle);
      vi.spyOn(lifecycle, 'openSession').mockImplementationOnce(phase === 'open' ? fail : async input => ({ ...await open(input), activate: fail }));
    }
    const rejected = expect(f.open(request)).rejects.toMatchObject({ name: 'AbortError' });
    const fault = f.registry as unknown as { failure?: unknown; failureSettlement?: Promise<void> };
    try {
      await entered.promise; f.registry.failExecution(new Error('Synthetic fence.')); release.resolve();
      await rejected; await f.registry.settleWriters();
    } finally { release.resolve(); delete fault.failure; delete fault.failureSettlement; }
  });

  it('settles a rejected interrupt and releases its worker and transcript on close', async () => {
    const f = await fixture(); const request = await f.request(); const open = vi.spyOn(f.registry, 'openHostWorker');
    const worker = await f.open(request); const binding = await open.mock.results[0]!.value;
    const fault = f.registry as unknown as { failure?: unknown; failureSettlement?: Promise<void>; pathClaims: Set<string> };
    const aborted = new Error('Interrupt failed.');
    const abort = vi.spyOn(binding.runtime.session, 'abort').mockRejectedValueOnce(aborted);
    try {
      f.registry.beginDrain(); await vi.waitFor(() => expect(f.registry.fenced).toBe(true));
      await expect(f.registry.settleWriters()).resolves.toBeUndefined();
      await worker.dispose();
      expect(abort.mock.calls.length).toBeGreaterThan(1);
      expect(fault.pathClaims.has(request.sessionManager.getSessionFile()!)).toBe(false);
      await expect(binding.agentRuntime.readFile('artifact.txt')).rejects.toThrow('Session runtime is closed to new work.');
      delete fault.failure; delete fault.failureSettlement; f.registry.endDrain();
      const next = await f.open(await f.request()); await next.prompt('Work after failed interruption.'); await next.dispose();
    } finally { abort.mockRestore(); await worker.dispose(); delete fault.failure; delete fault.failureSettlement; f.registry.endDrain(); }
  });

  it.each([1, 2])('joins all worker closes before reporting %i shutdown failures', async failures => {
    const f = await fixture(); const requests = await Promise.all([f.request(), f.request(), f.request()]);
    const workers = await Promise.all(requests.map(request => f.open(request)));
    const hostWorkers = (f.registry as unknown as { hostWorkers: HostWorkers }).hostWorkers;
    const close = hostWorkers.close.bind(hostWorkers); const entered = gate(); const release = gate();
    const errors = Array.from({ length: failures }, (_, index) => new Error(`Close ${index} failed.`));
    const delayed = requests[2]!.sessionManager.getSessionId();
    const spy = vi.spyOn(hostWorkers, 'close').mockImplementation(async id => {
      const index = requests.findIndex(request => request.sessionManager.getSessionId() === id);
      if (index < failures) throw errors[index];
      if (id === delayed) { entered.resolve(); await release.promise; }
      await close(id);
    });
    let settled = false;
    const failure = hostWorkers.shutdown().catch(error => { settled = true; return error; });
    try {
      await entered.promise; await new Promise(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      release.resolve();
      const error = await failure;
      if (failures === 1) expect(error).toBe(errors[0]);
      else { expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toHaveLength(errors.length); expect(error.errors).toEqual(expect.arrayContaining(errors)); }
      expect(hostWorkers.roots()).not.toContain(delayed);
    } finally { release.resolve(); await failure; spy.mockRestore(); await Promise.all(workers.map(worker => worker.dispose())); }
  });

  it('resolves global enabled models for providers and rejects workers outside the scope', async () => {
    const f = await fixture(); const request = await f.request();
    await expect(f.maintenance.service.allowedModels()).resolves.toBeUndefined();
    await f.configuration.set('global', { scopedModels: ['offline/*'] });
    await expect(f.maintenance.service.allowedModels()).resolves.toEqual([{ provider: 'offline', id: 'fixture' }]);
    const worker = await f.open(request); await worker.dispose();
    await f.configuration.set('global', { scopedModels: ['not-available/*'] });
    await expect(f.maintenance.service.allowedModels()).resolves.toEqual([]);
    const open = vi.spyOn(f.registry, 'openHostWorker');
    await expect(f.open(await f.request())).rejects.toThrow('outside the current scope');
    expect(open).not.toHaveBeenCalled();
    await f.configuration.set('global', { scopedModels: [] });
    await expect(f.maintenance.service.allowedModels()).resolves.toBeUndefined();
  });

  it('rejects maintenance methods with AbortError and revokes retained history after close', async () => {
    const f = await fixture(); const request = await f.request();
    const history = f.maintenance.service.sessions({ kind: 'all' });
    f.maintenance.close();
    expect(f.maintenance.service.signal.aborted).toBe(true);
    expect(() => f.open(request)).toThrow(expect.objectContaining({ name: 'AbortError' }));
    expect(() => f.maintenance.service.sessions({ kind: 'all' })).toThrow(expect.objectContaining({ name: 'AbortError' }));
    await expect(f.maintenance.service.allowedModels()).rejects.toMatchObject({ name: 'AbortError' });
    await expect(history.list({ scope: 'visible' })).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('cancels model scope resolution when maintenance closes', async () => {
    const f = await fixture();
    await f.configuration.set('global', { scopedModels: ['offline/*'] });
    const entered = gate(); const release = gate();
    const original = f.configuration.get.bind(f.configuration);
    vi.spyOn(f.configuration, 'get').mockImplementation(async scope => {
      entered.resolve(); await release.promise; return original(scope);
    });
    const pending = f.maintenance.service.allowedModels();
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise; f.maintenance.close(); release.resolve(); await rejected;
  });

  it.each(['drain', 'shutdown', 'settle'] as const)('joins an opening worker during %s without leaking its runtime', async action => {
    const f = await fixture(); const request = await f.request(); const opened = gate(); const release = gate();
    const lifecycle = f.registry.options.lifecycle; const open = lifecycle.openSession.bind(lifecycle);
    let binding: Awaited<ReturnType<typeof open>> | undefined;
    vi.spyOn(lifecycle, 'openSession').mockImplementationOnce(async input => {
      binding = await open(input); opened.resolve(); await release.promise; return binding;
    });
    const worker = f.open(request);
    const rejection = action === 'settle' ? worker.then(value => value.dispose()) : expect(worker).rejects.toMatchObject({ name: 'AbortError' });
    await opened.promise;
    let drained = false;
    const draining = (action === 'drain' ? (f.registry.beginDrain(), f.registry.waitForDrain())
      : action === 'shutdown' ? f.registry.shutdown() : f.registry.settleWriters()).then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    release.resolve(); await rejection; await draining;
    expect(await f.registry.activeWork()).toBe(0);
    expect(f.store.findSessionMetadata(request.sessionManager.getSessionId())).toBeUndefined();
    await expect(binding!.agentRuntime.readFile('artifact.txt')).rejects.toThrow('Session runtime is closed to new work.');
    if (action === 'drain') f.registry.endDrain();
  });

  it('cancels a running worker and refuses new workers when fenced', async () => {
    const stream = gate(); const entered = gate();
    const f = await fixture({ onStream: async () => { entered.resolve(); await stream.promise; } });
    const worker = await f.open(await f.request()); const request = await f.request();
    const rejected = expect(worker.prompt('Wait for cancellation.')).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise;
    const fault = f.registry as unknown as { failure?: unknown; failureSettlement?: Promise<void> };
    try {
      f.registry.failExecution(new Error('Synthetic fence.'));
      expect(() => f.open(request)).toThrow(expect.objectContaining({ name: 'AbortError' }));
      let settled = false;
      const settling = f.registry.settleWriters().then(() => { settled = true; });
      await Promise.resolve(); expect(settled).toBe(false);
      stream.resolve(); await rejected; await settling;
      await worker.dispose();
    } finally { stream.resolve(); delete fault.failure; delete fault.failureSettlement; }
  });

  it('fences the registry when worker cleanup fails', async () => {
    const f = await fixture(); const request = await f.request(); const open = vi.spyOn(f.registry, 'openHostWorker');
    const worker = await f.open(request); const binding = await open.mock.results[0]!.value;
    const dispose = vi.spyOn(binding.runtime, 'dispose').mockRejectedValueOnce(new Error('Cleanup failed.'));
    const fault = f.registry as unknown as { failure?: unknown; failureSettlement?: Promise<void> };
    try {
      await expect(worker.dispose()).rejects.toThrow('Cleanup failed.');
      expect(f.registry.fenced).toBe(true);
      expect(() => f.open(request)).toThrow(expect.objectContaining({ name: 'AbortError' }));
      await f.registry.settleWriters();
      dispose.mockRestore(); await worker.dispose();
    } finally { delete fault.failure; delete fault.failureSettlement; }
  });
});
