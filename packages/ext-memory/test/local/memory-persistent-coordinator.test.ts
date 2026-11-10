import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostAgentRuntime, SessionManager, type Api, type HostWorker, type Model, type ModelsService, type SessionsService } from '@felan-ai/agent-core';
import { createSessionCheckpoint, digestActiveBranch, type SessionCheckpoint } from '../../src/index.js';
import { LocalMemoryCoordinator, type LocalMemoryCoordinatorOptions } from '../../src/local/coordinator.js';
import type { MemoryContext } from '../../src/local/context.js';
import { resolveLocalMemoryProject } from '../../src/local/project.js';
import { LocalMemoryStore } from '../../src/local/store.js';

const roots: string[] = [];
const coordinators: LocalMemoryCoordinator[] = [];
const releases: Array<() => void> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const release of releases.splice(0)) release();
  await Promise.all(coordinators.splice(0).map(coordinator => coordinator.dispose()));
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('persistent memory scheduling', { timeout: 15_000 }, () => {
  it('opens stored pending work by cwd and dreams without a session attachment', async () => {
    const f = await fixture();
    await f.seed(5);
    expect(await f.store.pendingAcceptedUpdates()).toBe(5);
    expect((await f.store.status()).processed).toEqual({});
    const persistent = f.attach('persistent', true);

    await persistent.status(f.cwd);
    await vi.waitFor(async () => expect(await f.store.readControl()).toMatchObject({ lastOutcome: { status: 'success' } }), { timeout: 5_000 });
    expect(f.runner).toHaveBeenCalledOnce();
    expect(f.runner.mock.calls[0]![0].models).toBe(f.models.get('persistent'));
    expect(await f.store.pendingAcceptedUpdates()).toBe(0);
  });

  it.each(['before', 'after'] as const)('joins a project %s its context exists and keeps its timer after session detach', async timing => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = await fixture({ debounceMs: 60_000 });
    const session = f.attach('session');
    let persistent;
    if (timing === 'before') {
      persistent = f.attach('persistent', true);
      await persistent.status(f.cwd);
    }
    await session.status(f.cwd);
    if (timing === 'after') {
      persistent = f.attach('persistent', true);
      await persistent.status(f.cwd);
    }
    await f.seed(5, checkpoint => session.recordCheckpoint(f.cwd, checkpoint));
    await vi.waitFor(async () => expect(await f.store.readControl()).toMatchObject({ lastOutcome: { status: 'success' } }), { timeout: 5_000 });
    await vi.waitFor(() => expect(session.busy()).toBe(false), { timeout: 5_000 });
    expect(f.runner.mock.calls[0]![0].models).toBe(f.models.get('session'));

    await f.seed(5, checkpoint => session.recordCheckpoint(f.cwd, checkpoint));
    expect(await session.status(f.cwd)).toMatchObject({ state: 'scheduled', pendingCheckpoints: 5 });
    await session.detach();
    expect(f.runner).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(async () => expect(await f.store.pendingAcceptedUpdates()).toBe(0), { timeout: 4_000 });
    expect(f.runner).toHaveBeenCalledTimes(2);
    expect(f.runner.mock.calls[1]![0].models).toBe(f.models.get('persistent'));
    expect(f.histories.get('persistent')).toHaveBeenCalled();
    if (persistent) await vi.waitFor(async () => expect(await persistent.status(f.cwd)).toMatchObject({ state: 'idle' }), { timeout: 5_000 });
  });

  it.each(['before', 'after'] as const)('keeps project-scoped recovery and scheduling isolated when tracking starts %s another context exists', async timing => {
    const f = await fixture({ enabled: false, recover: true, recoveryStableMs: 0 });
    await f.seed(1);
    const otherCwd = join(f.cwd, '..', 'other-workspace');
    await mkdir(otherCwd);
    const environment = f.environment('persistent');
    const list = vi.spyOn(environment.sessions, 'list').mockResolvedValue({ items: [{
      id: 'source-0', root: 'source-0', cwd: f.cwd, title: '', updatedAt: 0, state: 'closed',
    }] });
    const otherEnvironment = f.environment('other-session', otherCwd);
    const otherProject = await resolveLocalMemoryProject(otherEnvironment, otherCwd);
    expect(otherProject.key).not.toBe((await resolveLocalMemoryProject(environment, f.cwd)).key);
    const otherStore = new LocalMemoryStore(otherEnvironment, f.agentDir, otherProject);
    await otherStore.initialize();
    for (let index = 0; index < 5; index++) {
      const id = `other-source-${index}`;
      const path = join(otherCwd, `${id}.jsonl`);
      await writeFile(path, [JSON.stringify({ type: 'session', version: 3, id, cwd: otherCwd, timestamp: new Date().toISOString() }),
        JSON.stringify({ type: 'message', id: 'entry', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Other project evidence.' } }), ''].join('\n'));
      await otherStore.recordCheckpoint(createSessionCheckpoint(SessionManager.open(path))!);
    }
    const before = await otherStore.status();
    const track = async () => {
      const attachment = f.coordinator.attach({ environment, models: {} as ModelsService, scheduling: true, persistent: true });
      await attachment.status(f.cwd);
      return attachment;
    };
    const persistentBefore = timing === 'before' ? await track() : undefined;
    const session = f.coordinator.attach({ environment: otherEnvironment, models: {} as ModelsService, scheduling: true });
    await session.status(otherCwd);
    await session.detach();
    const persistent = persistentBefore ?? await track();

    f.coordinator.setEnabled(true);
    await vi.waitFor(() => expect(persistent.busy()).toBe(false), { timeout: 5_000 });
    await f.coordinator.drain();
    expect(list).toHaveBeenCalledOnce();
    expect(f.histories.get('persistent')?.mock.calls.map(([id]) => id)).toEqual(['source-0']);
    expect(f.histories.get('other-session')).not.toHaveBeenCalled();
    expect(await otherStore.status()).toEqual(before);
    expect(f.runner).not.toHaveBeenCalled();
  });

  it('prefers a live session even when a persistent attachment requests the run', async () => {
    const f = await fixture();
    const session = f.attach('session');
    await session.status(f.cwd);
    const persistent = f.attach('persistent', true);
    await f.seed(1);
    await persistent.runNow(f.cwd);
    expect(f.runner.mock.calls[0]![0].models).toBe(f.models.get('session'));
    expect(f.histories.get('session')).toHaveBeenCalled();
    expect(f.histories.get('persistent')).not.toHaveBeenCalled();
  });

  it('re-arms cancelled session work through the persistent attachment', async () => {
    const entered = deferred();
    const retry = deferred();
    let runs = 0;
    const f = await fixture({ dreamRunner: async input => {
      if (++runs === 1) {
        entered.resolve();
        await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }));
      } else await retry.promise;
      return input.baseSnapshot;
    } });
    const session = f.attach('session');
    await f.attach('persistent', true).status(f.cwd);
    await f.seed(5, checkpoint => session.recordCheckpoint(f.cwd, checkpoint));
    await entered.promise;
    const before = await f.store.status();
    await session.detach();
    await vi.waitFor(() => expect(runs).toBe(2), { timeout: 5_000 });
    expect(await f.store.status()).toEqual(before);
    const control = await f.store.readControl();
    expect(control).toMatchObject({ lastOutcome: { status: 'cancelled' }, consecutiveFailures: 0 });
    expect(control.nextRetryAt).toBeUndefined();
    expect(JSON.parse(await readFile(join(f.store.projectDirectory, 'runs', control.lastOutcome!.runId, 'manifest.json'), 'utf8')))
      .toMatchObject({ status: 'cancelled' });
    retry.resolve();
    await vi.waitFor(async () => expect(await f.store.pendingAcceptedUpdates()).toBe(0), { timeout: 5_000 });
  });

  it.each(['interrupted', 'AbortError', 'unavailable', 'draining'] as const)('records %s during daemon drain as cancelled and schedules it on restart', async failure => {
    const entered = deferred();
    const aborted = deferred();
    const f = await fixture();
    await f.coordinator.dispose();
    const coordinator = new LocalMemoryCoordinator({ agentDir: f.agentDir, recover: false });
    coordinators.push(coordinator);
    const model = { provider: 'openai-codex', id: 'gpt-5.6-luna', input: ['text'] } as Model<Api>;
    const environment = f.environment('worker');
    const tools = ['read', 'ls', 'grep', 'edit', 'write', 'remove_memory_page'];
    const worker = {
      abort: async () => { aborted.resolve(); },
      bindExtensions: async () => {},
      getActiveToolNames: () => tools,
      setActiveToolsByName: () => {},
      subscribe: () => () => {},
      thinkingLevel: 'medium',
      messages: [{ role: 'assistant', stopReason: 'aborted' }],
      prompt: async () => {
        entered.resolve();
        await aborted.promise;
        if (failure === 'AbortError') throw new DOMException('Host closed', 'AbortError');
        if (failure === 'unavailable') throw new DOMException('Host maintenance is unavailable.', 'AbortError');
      },
      dispose: () => {},
    } as unknown as HostWorker;
    const openWorker = vi.fn(async () => {
      if (failure === 'draining') {
        entered.resolve();
        await aborted.promise;
        throw new DOMException('Daemon is draining.', 'AbortError');
      }
      return worker;
    });
    const persistent = coordinator.attach({ environment: { ...environment, openWorker },
      models: { getAvailable: () => [model] } as unknown as ModelsService, scheduling: true, persistent: true });
    await f.seed(5);
    await persistent.status(f.cwd);
    await entered.promise;
    const draining = coordinator.drain();
    await worker.abort();
    await draining;
    expect(await f.store.readControl()).toMatchObject({ lastOutcome: { status: 'cancelled' }, consecutiveFailures: 0 });
    expect((await f.store.readControl()).nextRetryAt).toBeUndefined();
    expect(await f.store.pendingAcceptedUpdates()).toBe(5);
    await coordinator.dispose();

    const restarted = new LocalMemoryCoordinator({ agentDir: f.agentDir, recover: false, dreamRunner: f.runner });
    coordinators.push(restarted);
    await restarted.attach({ environment, models: {} as ModelsService, scheduling: true, persistent: true }).status(f.cwd);
    await vi.waitFor(async () => expect(await f.store.pendingAcceptedUpdates()).toBe(0), { timeout: 5_000 });
    expect(f.runner).toHaveBeenCalledOnce();
  });

  it.each(['open', 'prompt', 'response', 'named error'] as const)('re-arms %s cancellation without draining the attachment', async stage => {
    const interrupted = deferred();
    const entered = deferred();
    const retryEntered = deferred();
    const retry = deferred();
    const f = await fixture();
    await f.coordinator.dispose();
    const coordinator = new LocalMemoryCoordinator({ agentDir: f.agentDir, recover: false });
    coordinators.push(coordinator);
    const environment = f.environment('worker');
    const model = { provider: 'openai-codex', id: 'gpt-5.6-luna', input: ['text'] } as Model<Api>;
    let cancelled = false;
    const fail = async () => {
      entered.resolve();
      await interrupted.promise;
      cancelled = true;
      if (stage === 'named error') throw { name: 'AbortError', message: 'Host closed' };
      throw new DOMException('Host closed', 'AbortError');
    };
    const worker = {
      abort: async () => {}, bindExtensions: async () => {},
      getActiveToolNames: () => ['read', 'ls', 'grep', 'edit', 'write', 'remove_memory_page'],
      setActiveToolsByName: () => {}, subscribe: () => () => {}, thinkingLevel: 'medium',
      get messages() { return [{ role: 'assistant', stopReason: cancelled ? 'stop' : 'aborted' }]; },
      prompt: async () => {
        if (!cancelled) {
          if (stage !== 'response') return fail();
          entered.resolve();
          await interrupted.promise;
          return;
        }
        retryEntered.resolve();
        await retry.promise;
      },
      dispose: () => { if (stage === 'response') cancelled = true; },
    } as unknown as HostWorker;
    const openWorker = vi.fn(async () => {
      if (stage === 'open' && !cancelled) await fail();
      return worker;
    });
    const attachment = coordinator.attach({ environment: { ...environment, openWorker },
      models: { getAvailable: () => [model] } as unknown as ModelsService, scheduling: true, persistent: true });
    await f.seed(5);
    await attachment.status(f.cwd);
    await entered.promise;
    interrupted.resolve();
    await retryEntered.promise;
    expect(await f.store.readControl()).toMatchObject({ lastOutcome: { status: 'cancelled' }, consecutiveFailures: 0 });
    expect((await f.store.readControl()).nextRetryAt).toBeUndefined();
    expect(await f.store.pendingAcceptedUpdates()).toBe(5);
    retry.resolve();
    await vi.waitFor(async () => expect(await f.store.pendingAcceptedUpdates()).toBe(0), { timeout: 5_000 });
    expect(openWorker).toHaveBeenCalledTimes(2);
  });

  it('still stops scheduling when the last non-persistent attachment detaches', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = await fixture({ debounceMs: 60_000 });
    const session = f.attach('session');
    await f.seed(1, checkpoint => session.recordCheckpoint(f.cwd, checkpoint));
    await session.runNow(f.cwd);
    await f.seed(5, checkpoint => session.recordCheckpoint(f.cwd, checkpoint));
    await session.detach();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(f.runner).toHaveBeenCalledOnce();
    expect(await f.store.pendingAcceptedUpdates()).toBe(5);
  });
});

async function fixture(options: Partial<LocalMemoryCoordinatorOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'felan-memory-persistent-'));
  roots.push(root);
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  await mkdir(cwd);
  const histories = new Map<string, ReturnType<typeof vi.fn>>();
  const models = new Map<string, ModelsService>();
  const environment = (id: string, projectCwd = cwd): MemoryContext => {
    const checkpoint = async (sessionId: string) => {
      const path = join(projectCwd, `${sessionId}.jsonl`);
      const revision = await readFile(path, 'utf8');
      const manager = SessionManager.open(path);
      return { sessionId, revision, branch: manager.getLeafId(), transcriptDigest: digestActiveBranch(manager.getBranch()), byteLength: Buffer.byteLength(revision) };
    };
    const history = vi.fn(async (sessionId: string) => ({ ...await checkpoint(sessionId), entries: SessionManager.open(join(projectCwd, `${sessionId}.jsonl`)).getEntries() }));
    histories.set(id, history);
    return {
      runtime: new HostAgentRuntime(projectCwd, { pathAccess: 'host', sessionStorageRoot: join(root, id), agentStorageRoot: agentDir }),
      sessions: { current: { id, root: id }, list: async () => ({ items: [] }), checkpoint, history } as unknown as SessionsService,
    };
  };
  const storage = environment('storage');
  const store = new LocalMemoryStore(storage, agentDir, await resolveLocalMemoryProject(storage, cwd));
  await store.initialize();
  const runner = vi.fn<NonNullable<LocalMemoryCoordinatorOptions['dreamRunner']>>(async input => input.baseSnapshot);
  const coordinator = new LocalMemoryCoordinator({ agentDir, recover: false, dreamRunner: runner, ...options });
  coordinators.push(coordinator);
  let count = 0;
  return { cwd, agentDir, store, coordinator, runner, environment, histories, models,
    attach(id: string, persistent = false) {
      const modelService = {} as ModelsService;
      models.set(id, modelService);
      return coordinator.attach({ environment: environment(id), models: modelService, scheduling: true, persistent });
    },
    async seed(amount: number, record: (checkpoint: SessionCheckpoint) => Promise<unknown> = checkpoint => store.recordCheckpoint(checkpoint)) {
      for (let index = 0; index < amount; index++) {
        const id = `source-${count++}`;
        const path = join(cwd, `${id}.jsonl`);
        await writeFile(path, [JSON.stringify({ type: 'session', version: 3, id, cwd, timestamp: new Date().toISOString() }),
          JSON.stringify({ type: 'message', id: 'entry', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Remember the project preference.' } }), ''].join('\n'));
        await record(createSessionCheckpoint(SessionManager.open(path))!);
      }
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => { resolve = settle; });
  releases.push(resolve);
  return { promise, resolve };
}
