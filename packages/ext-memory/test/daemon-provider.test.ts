import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOST_MAINTENANCE_SERVICE, HOST_MODELS_SERVICE, MODELS_SERVICE, SESSIONS_SERVICE,
  HostAgentRuntime, SessionManager,
  type Api, type ExtensionServiceAccess, type FelanExtensionAPI, type HostMaintenance,
  type HostWorker, type Model, type ModelsService, type SessionCheckpointRef, type SessionsHistory,
} from '@felan-ai/agent-core';
import defaultProvider, { createMemoryDaemonProvider, MEMORY_SCHEDULER_SERVICE } from '../src/daemon-provider.js';
import extension from '../src/extension.js';
import { createSessionCheckpoint, digestActiveBranch } from '../src/index.js';
import type { LocalMemoryAttachment } from '../src/local/coordinator.js';
import type { MemoryContext } from '../src/local/context.js';
import { resolveLocalMemoryProject } from '../src/local/project.js';
import { acquireSharedLocalMemoryCoordinator } from '../src/local/shared.js';
import { LocalMemoryStore } from '../src/local/store.js';

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  const results = await Promise.allSettled(cleanups.splice(0).reverse().map(cleanup => cleanup()));
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, 'Memory daemon fixture cleanup failed');
});

describe('memory daemon provider', { timeout: 15_000 }, () => {
  it('declares valid daemon provider contracts', () => {
    expect(defaultProvider.scope).toBe('daemon');
    expect(defaultProvider.provides).toEqual([MEMORY_SCHEDULER_SERVICE]);
    expect(defaultProvider.requires).toEqual([HOST_MAINTENANCE_SERVICE]);
    expect(defaultProvider.optional).toEqual([HOST_MODELS_SERVICE]);
    expect(typeof defaultProvider.create).toBe('function');
    expect(defaultProvider.provides.length).toBeGreaterThan(0);
    for (const contracts of [defaultProvider.provides, defaultProvider.requires, defaultProvider.optional]) {
      expect(new Set(contracts.map(contract => contract.key)).size).toBe(contracts.length);
      for (const contract of contracts) {
        expect(contract.id).toMatch(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u);
        expect(contract.id.length).toBeLessThanOrEqual(128);
        expect(Number.isSafeInteger(contract.major)).toBe(true);
        expect(contract.major).toBeGreaterThanOrEqual(1);
        expect(contract.major).toBeLessThanOrEqual(65_535);
        expect(contract.key).toBe(`${contract.id}@${contract.major}`);
      }
    }
    expect(defaultProvider.requires.some(required => defaultProvider.optional.some(optional => optional.key === required.key))).toBe(false);
  });

  it('activates lazily and dreams stored accepted updates through host workers with no session attachment', async () => {
    const f = await fixture();
    const store = await f.seed(f.cwd, 5);
    expect(await store.pendingAcceptedUpdates()).toBe(5);
    const provider = await f.create();
    expect(f.get).not.toHaveBeenCalled();
    expect(f.attach).not.toHaveBeenCalled();
    const activation = provider.activate();
    expect(provider.activate()).toBe(activation);
    await activation;
    await vi.waitFor(async () => expect(await store.readControl()).toMatchObject({ lastOutcome: { status: 'success' } }), { timeout: 5_000 });
    expect(f.attach).toHaveBeenCalledOnce();
    expect(f.attach.mock.calls[0]![0]).toMatchObject({ persistent: true, scheduling: true, models: f.models });
    expect(f.sessions).toHaveBeenCalledWith({ kind: 'all' });
    expect(f.openWorker).toHaveBeenCalledOnce();
    expect(f.openWorker.mock.calls[0]![0]).toMatchObject({ model: { provider: 'openai-codex', id: 'gpt-5.6-luna' } });
    expect(f.worker.dispose).toHaveBeenCalledOnce();
    expect(await store.pendingAcceptedUpdates()).toBe(0);
    expect(await provider.implementations[0]!.value.status()).toEqual([
      { projectRoot: f.cwd, status: expect.objectContaining({ enabled: true, pendingCheckpoints: 0 }) },
    ]);
  });

  it('keeps projects readable without models and never schedules a worker', async () => {
    const f = await fixture();
    const store = await f.seed(f.cwd, 5);
    const provider = await f.create({}, false);
    await provider.activate();
    expect(f.attach.mock.calls[0]![0]).toMatchObject({ persistent: true, scheduling: false });
    expect(await provider.implementations[0]!.value.status()).toEqual([
      { projectRoot: f.cwd, status: expect.objectContaining({ enabled: false, state: 'disabled', pendingCheckpoints: 5,
        message: expect.stringContaining('does not provide models') }) },
    ]);
    expect(f.openWorker).not.toHaveBeenCalled();
    expect(await store.pendingAcceptedUpdates()).toBe(5);
  });

  it('schedules projects created after activation on a coordinator status change', async () => {
    const f = await fixture();
    const provider = await f.create();
    await provider.activate();
    expect(f.attach).not.toHaveBeenCalled();
    const store = await f.seed(f.cwd, 5);
    const session = f.shared.coordinator.attach({ environment: f.environment, models: f.models, scheduling: false });
    await session.status(f.cwd);
    await session.recordCheckpoint(f.cwd, createSessionCheckpoint(SessionManager.open(join(f.cwd, 'source-5.jsonl')))!);
    await session.detach();
    await vi.waitFor(async () => expect(await store.pendingAcceptedUpdates()).toBe(0), { timeout: 5_000 });
    expect(f.openWorker).toHaveBeenCalledOnce();
    expect(f.attach.mock.calls.filter(([options]) => options.persistent)).toHaveLength(1);
  });

  it('rescans on an unreferenced ten-minute timer and deduplicates extra project roots', async () => {
    const f = await fixture();
    const interval = vi.spyOn(globalThis, 'setInterval');
    const provider = await f.create({ projects: [f.cwd, join(f.cwd, '.')] }, false);
    await provider.activate();
    expect(f.attach).toHaveBeenCalledOnce();
    expect(interval).toHaveBeenCalledWith(expect.any(Function), 600_000);
    expect(interval.mock.results[0]!.value.hasRef()).toBe(false);
    const later = join(f.root, 'later');
    await f.seed(later, 1);
    await interval.mock.calls[0]![0]();
    await vi.waitFor(() => expect(f.attach).toHaveBeenCalledTimes(2));
    await provider.settle('drain');
    await interval.mock.calls[0]![0]();
    expect(f.attach).toHaveBeenCalledTimes(2);
    expect(await provider.implementations[0]!.value.status()).toEqual([]);
  });

  it('uses a custom runtime and all-session selector for an explicit team project', async () => {
    const f = await fixture();
    const selector = vi.fn(() => ({ kind: 'all' as const }));
    const provider = await f.create({ runtime: f.environment.runtime, projects: [f.cwd], selector }, false);
    await provider.activate();
    expect(selector).toHaveBeenCalledWith(await resolveLocalMemoryProject(f.environment, f.cwd));
    expect(f.attach.mock.calls[0]![0].environment.runtime).toBe(f.environment.runtime);
    expect(f.sessions.mock.calls.every(([selection]) => selection.kind === 'all')).toBe(true);
  });

  it('resolves subdirectory sessions to their git-root project and materializes their checkpoints', async () => {
    const f = await fixture();
    await mkdir(join(f.cwd, '.git'));
    await writeFile(join(f.cwd, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await mkdir(join(f.cwd, '.git', 'objects'));
    await mkdir(join(f.cwd, '.git', 'refs'));
    const subdirectory = join(f.cwd, 'packages', 'app');
    const store = await f.seed(subdirectory, 5);
    await f.seed(join(f.root, 'other'), 0);
    const provider = await f.create({ projects: [f.cwd], discover: false });
    await provider.activate();
    const history = f.attach.mock.calls[0]![0].environment.sessions;
    expect((await history.list({ scope: 'visible' })).items.map(item => item.id))
      .toEqual(['source-0', 'source-1', 'source-2', 'source-3', 'source-4', 'source-5']);
    expect(await history.checkpoint('source-0')).toMatchObject({ sessionId: 'source-0' });
    await vi.waitFor(async () => expect(await store.readControl()).toMatchObject({ lastOutcome: { status: 'success' } }), { timeout: 5_000 });
    expect(f.readHistory).toHaveBeenCalledWith('source-0', expect.anything());
    expect(await store.pendingAcceptedUpdates()).toBe(0);
    expect(f.attach).toHaveBeenCalledOnce();
  });

  it('keeps paginated project listings scoped without changing read access or cursors', async () => {
    const f = await fixture();
    await f.seed(f.cwd, 0);
    await f.seed(join(f.root, 'other'), 0);
    f.list.mockResolvedValueOnce({ items: [{ id: 'other', root: 'other', cwd: join(f.root, 'other'), title: '', updatedAt: 0, state: 'closed' }], nextCursor: 'next' });
    const provider = await f.create({ projects: [f.cwd], discover: false }, false);
    await provider.activate();
    const history = f.attach.mock.calls[0]![0].environment.sessions;
    expect(await history.list({ scope: 'visible' }, { limit: 1 })).toEqual({ items: [], nextCursor: 'next' });
    expect(await history.checkpoint('source-1')).toMatchObject({ sessionId: 'source-1' });
    expect(f.list).toHaveBeenCalledWith({ scope: 'visible' }, { limit: 1 });
  });

  it('does not discover stored project directories when discovery is disabled and refreshes explicit roots periodically', async () => {
    const f = await fixture();
    await f.seed(join(f.root, 'other'), 1);
    const runtime = f.environment.runtime;
    const listFiles = vi.spyOn(runtime, 'listFiles');
    const exec = vi.spyOn(runtime, 'exec');
    const factory = vi.fn(() => runtime);
    const interval = vi.spyOn(globalThis, 'setInterval');
    const provider = await f.create({ runtime: factory, projects: [f.cwd], discover: false }, false);
    expect(factory).not.toHaveBeenCalled();
    await provider.activate();
    const resolutions = exec.mock.calls.length;
    await interval.mock.calls[0]![0]();
    await vi.waitFor(() => expect(exec.mock.calls.length).toBeGreaterThan(resolutions));
    expect(factory).toHaveBeenCalledOnce();
    expect(listFiles).not.toHaveBeenCalledWith(join(f.agentDir, 'memory', 'v1', 'projects'), expect.anything());
    expect(f.attach).toHaveBeenCalledOnce();
    expect((await provider.implementations[0]!.value.status()).map(item => item.projectRoot)).toEqual([f.cwd]);
  });

  it('coalesces status-change rescans for two seconds', async () => {
    const f = await fixture();
    const subscribe = vi.spyOn(f.shared.coordinator, 'subscribeStatusChanges');
    const provider = await f.create({ discover: false }, false);
    await provider.activate();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const notify = subscribe.mock.calls[0]![0];
    notify();
    notify();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(f.allowedModels).toHaveBeenCalledOnce();
    notify();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.allowedModels).toHaveBeenCalledTimes(2);
  });

  it('keeps scheduling enabled across rescans while the resolved scope is unchanged', async () => {
    const f = await fixture();
    const subscribe = vi.spyOn(f.shared.coordinator, 'subscribeStatusChanges');
    const provider = await f.create({ projects: [f.cwd], discover: false });
    await provider.activate();
    await vi.waitFor(async () => expect((await provider.implementations[0]!.value.status())[0]!.status.enabled).toBe(true));
    const attachment = f.attach.mock.results[0]!.value as LocalMemoryAttachment;
    const scheduling = vi.spyOn(attachment, 'setScheduling');
    const selection = vi.spyOn(attachment, 'setModelSelection');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    subscribe.mock.calls[0]![0]();
    await vi.advanceTimersByTimeAsync(2_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(f.allowedModels).toHaveBeenCalledTimes(2));
    await provider.implementations[0]!.value.status();
    expect(scheduling).not.toHaveBeenCalled();
    expect(selection).not.toHaveBeenCalled();
  });

  it('passes the allowed model scope to attachments and refreshes it on rescan', async () => {
    const f = await fixture();
    const model = (await f.models.getAvailable())[0]!;
    f.allowedModels.mockResolvedValue([{ provider: model.provider, id: model.id }]);
    const interval = vi.spyOn(globalThis, 'setInterval');
    const provider = await f.create({ projects: [f.cwd], discover: false });
    await provider.activate();
    expect(f.attach.mock.calls[0]![0].scopedModels).toEqual([model]);
    const attachment = f.attach.mock.results[0]!.value as LocalMemoryAttachment;
    const selection = vi.spyOn(attachment, 'setModelSelection');
    f.allowedModels.mockResolvedValue([]);
    await interval.mock.calls[0]![0]();
    await vi.waitFor(() => expect(selection).toHaveBeenCalledWith(undefined, [], undefined));
  });

  it.each(['configuration read', 'malformed scope'] as const)('keeps activation readable after a %s failure and retries scope on a debounced scan', async failure => {
    const f = await fixture();
    const store = await f.seed(f.cwd, 5);
    const subscribe = vi.spyOn(f.shared.coordinator, 'subscribeStatusChanges');
    const warn = vi.spyOn(f.environment.runtime.logger, 'warn');
    if (failure === 'configuration read') f.allowedModels.mockRejectedValue(new Error('secret=do-not-log'));
    else f.allowedModels.mockResolvedValue({ invalid: true } as never);
    const provider = await f.create({ runtime: f.environment.runtime });
    await expect(provider.activate()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Memory model scope is unavailable; scheduling remains paused');
    expect(await provider.implementations[0]!.value.status()).toEqual([
      { projectRoot: f.cwd, status: expect.objectContaining({ enabled: false, pendingCheckpoints: 5,
        message: expect.stringContaining('model scope') }) },
    ]);
    expect(f.openWorker).not.toHaveBeenCalled();
    f.allowedModels.mockResolvedValue(undefined);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    subscribe.mock.calls[0]![0]();
    await vi.advanceTimersByTimeAsync(2_000);
    vi.useRealTimers();
    await vi.waitFor(async () => expect(await store.pendingAcceptedUpdates()).toBe(0), { timeout: 5_000 });
    expect(f.attach).toHaveBeenCalledOnce();
  });

  it('resolves activation while model scope is pending and schedules once it resolves', async () => {
    const f = await fixture();
    const store = await f.seed(f.cwd, 5);
    let release!: () => void;
    f.allowedModels.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(undefined); }));
    const provider = await f.create({}, true, false);
    await provider.activate();
    expect(f.allowedModels).toHaveBeenCalledOnce();
    expect(f.attach).not.toHaveBeenCalled();
    expect(f.openWorker).not.toHaveBeenCalled();
    release();
    await vi.waitFor(async () => expect(await store.pendingAcceptedUpdates()).toBe(0), { timeout: 5_000 });
    expect(f.openWorker).toHaveBeenCalledOnce();
    expect((await provider.implementations[0]!.value.status())[0]!.status.enabled).toBe(true);
  });

  it.each(['dispose', 'drain'] as const)('bounds a hung model scope and completes %s', async mode => {
    const f = await fixture();
    await f.seed(f.cwd, 1);
    const warn = vi.spyOn(f.environment.runtime.logger, 'warn');
    f.allowedModels.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const provider = await f.create({ runtime: f.environment.runtime }, true, false);
    await expect(provider.activate()).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(1);
    let listed = false;
    const status = provider.implementations[0]!.value.status().then(result => { listed = true; return result; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(listed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    expect(await status).toEqual([
      { projectRoot: f.cwd, status: expect.objectContaining({ enabled: false, pendingCheckpoints: 1,
        message: expect.stringContaining('model scope') }) },
    ]);
    expect(warn).toHaveBeenCalledExactlyOnceWith('Memory model scope is unavailable; scheduling remains paused');
    expect(f.openWorker).not.toHaveBeenCalled();
    await expect(mode === 'dispose' ? provider.dispose() : provider.settle('drain')).resolves.toBeUndefined();
  });

  it('aborts a hung scope wait when host maintenance closes', async () => {
    const f = await fixture();
    f.allowedModels.mockImplementation(() => new Promise(() => {}));
    const warn = vi.spyOn(f.environment.runtime.logger, 'warn');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const provider = await f.create({ runtime: f.environment.runtime }, true, false);
    await provider.activate();
    f.lifetime.abort();
    await expect(provider.settle('drain')).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the resolved model scope after an aborted rescan without warning', async () => {
    const f = await fixture();
    const model = (await f.models.getAvailable())[0]!;
    f.allowedModels.mockResolvedValue([{ provider: model.provider, id: model.id }]);
    const interval = vi.spyOn(globalThis, 'setInterval');
    const warn = vi.spyOn(f.environment.runtime.logger, 'warn');
    const provider = await f.create({ runtime: f.environment.runtime, projects: [f.cwd], discover: false });
    await provider.activate();
    const attachment = f.attach.mock.results[0]!.value as LocalMemoryAttachment;
    const scheduling = vi.spyOn(attachment, 'setScheduling');
    const selection = vi.spyOn(attachment, 'setModelSelection');
    f.allowedModels.mockRejectedValue(new DOMException('Daemon is draining.', 'AbortError'));
    interval.mock.calls[0]![0]();
    expect((await provider.implementations[0]!.value.status())[0]!.status.enabled).toBe(true);
    expect(f.allowedModels).toHaveBeenCalledTimes(2);
    expect(scheduling).not.toHaveBeenCalled();
    expect(selection).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps scheduling after an interrupted worker without closing the provider', async () => {
    const f = await fixture();
    f.worker.prompt.mockRejectedValueOnce(new DOMException('Daemon is draining.', 'AbortError'));
    const store = await f.seed(f.cwd, 5);
    const provider = await f.create();
    await provider.activate();
    await vi.waitFor(async () => expect(await store.readControl()).toMatchObject({ consecutiveFailures: 0, lastOutcome: { status: 'success' } }),
      { timeout: 5_000 });
    expect(await store.pendingAcceptedUpdates()).toBe(0);
    expect(f.openWorker).toHaveBeenCalledTimes(2);
    expect(f.attach).toHaveBeenCalledOnce();
    await expect(provider.activate()).resolves.toBeUndefined();
  });

  it('refreshes cached session roots after git initialization on the periodic scan', async () => {
    const f = await fixture();
    const nested = join(f.cwd, 'nested');
    await f.seed(nested, 0);
    const interval = vi.spyOn(globalThis, 'setInterval');
    const provider = await f.create({ projects: [f.cwd], discover: false }, false);
    await provider.activate();
    const history = f.attach.mock.calls[0]![0].environment.sessions;
    expect((await history.list({ scope: 'visible' })).items).toEqual([]);
    await mkdir(join(f.cwd, '.git'));
    await writeFile(join(f.cwd, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await mkdir(join(f.cwd, '.git', 'objects'));
    await mkdir(join(f.cwd, '.git', 'refs'));
    interval.mock.calls[0]![0]();
    await vi.waitFor(async () => expect((await history.list({ scope: 'visible' })).items.map(item => item.id)).toEqual(['source-0']));
  });

  it.each([1, 5])('blocks missing project roots with %i updates without failures and resumes when the root returns', async updates => {
    const f = await fixture();
    const store = await f.seed(f.cwd, updates);
    const moved = `${f.cwd}-moved`;
    await rename(f.cwd, moved);
    const interval = vi.spyOn(globalThis, 'setInterval');
    const provider = await f.create();
    await provider.activate();
    const status = async () => (await provider.implementations[0]!.value.status())[0]!.status;
    await vi.waitFor(async () => expect(await status()).toMatchObject({ state: 'blocked', pendingCheckpoints: updates,
      consecutiveFailures: 0, message: expect.stringContaining('project root is unavailable') }));
    interval.mock.calls[0]![0]();
    await vi.waitFor(() => expect(f.allowedModels).toHaveBeenCalledTimes(2));
    expect(f.openWorker).not.toHaveBeenCalled();
    expect((await store.readControl()).consecutiveFailures).toBe(0);
    await rename(moved, f.cwd);
    interval.mock.calls[0]![0]();
    if (updates < 5) {
      await vi.waitFor(async () => expect(await status()).toMatchObject({ state: 'idle', pendingCheckpoints: updates, consecutiveFailures: 0 }));
      expect((await status()).message).toBeUndefined();
      expect(f.openWorker).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(async () => expect(await store.pendingAcceptedUpdates()).toBe(0), { timeout: 5_000 });
      expect(f.openWorker).toHaveBeenCalledOnce();
    }
  });

  it('marks attachments draining before host maintenance interrupts an active dream', async () => {
    const f = await fixture();
    let entered = false;
    let interrupt!: () => void;
    f.worker.prompt.mockImplementation(async () => {
      entered = true;
      await new Promise<void>((_, reject) => { interrupt = () => reject(new DOMException('Host closed', 'AbortError')); });
    });
    const store = await f.seed(f.cwd, 5);
    const provider = await f.create();
    await provider.activate();
    await vi.waitFor(() => expect(entered).toBe(true));
    const attachment = f.attach.mock.results[0]!.value as LocalMemoryAttachment;
    const settle = vi.spyOn(attachment, 'settle');
    f.lifetime.abort();
    expect(settle).toHaveBeenCalledWith('drain');
    interrupt();
    await provider.settle('drain');
    expect(await store.readControl()).toMatchObject({ lastOutcome: { status: 'cancelled' }, consecutiveFailures: 0 });
    expect(await store.pendingAcceptedUpdates()).toBe(5);
  });

  it('retries cleanup on dispose after settlement fails and releases its coordinator reference', async () => {
    const f = await fixture();
    const provider = await f.create({ projects: [f.cwd], discover: false }, false);
    await provider.activate();
    const attachment = f.attach.mock.results[0]!.value as LocalMemoryAttachment;
    vi.spyOn(attachment, 'settle').mockRejectedValueOnce(new Error('settle failed'));
    const detach = vi.spyOn(attachment, 'detach').mockRejectedValueOnce(new Error('detach failed'));
    const disposed = vi.spyOn(f.shared.coordinator, 'dispose');
    await expect(provider.settle('drain')).rejects.toBeInstanceOf(AggregateError);
    await expect(provider.activate()).rejects.toThrow('Memory scheduler is closed');
    await provider.dispose();
    expect(detach).toHaveBeenCalledTimes(2);
    await f.shared.release();
    expect(disposed).toHaveBeenCalledOnce();
  });

  it('resolves activation before the first project scan finishes', async () => {
    const f = await fixture();
    await f.seed(f.cwd, 1);
    let release!: () => void;
    const initialize = vi.spyOn(LocalMemoryStore.prototype, 'initialize')
      .mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const provider = await f.create({}, false, false);
    await provider.activate();
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce());
    const status = provider.implementations[0]!.value.status();
    release();
    expect(await status).toEqual([{ projectRoot: f.cwd, status: expect.objectContaining({ pendingCheckpoints: 1 }) }]);
  });

  it('retries transient project initialization failures on the next scan without duplicating attachments', async () => {
    const f = await fixture();
    const store = await f.seed(f.cwd, 5);
    const initialize = vi.spyOn(LocalMemoryStore.prototype, 'initialize').mockRejectedValueOnce(new Error('Storage temporarily unavailable'));
    const interval = vi.spyOn(globalThis, 'setInterval');
    const provider = await f.create({}, true, false);
    await provider.activate();
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce());
    expect(f.openWorker).not.toHaveBeenCalled();
    await interval.mock.calls[0]![0]();
    await vi.waitFor(async () => expect(await store.pendingAcceptedUpdates()).toBe(0), { timeout: 5_000 });
    expect(f.attach).toHaveBeenCalledOnce();
    expect(f.openWorker).toHaveBeenCalledOnce();
  });

  it('shares the extension coordinator and releases only its own attachments', async () => {
    const f = await fixture();
    const provider = await f.create({ projects: [f.cwd] }, false);
    await provider.activate();
    const handlers = new Map<string, () => Promise<void>>();
    extension({
      runtime: f.environment.runtime, agentDir: f.agentDir,
      services: { get: (contract: { key: string }) => contract.key === MODELS_SERVICE.key ? f.models
        : contract.key === SESSIONS_SERVICE.key ? { ...f.environment.sessions, current: { id: 'reader', root: 'host' } } : undefined },
      on: (event: string, handler: () => Promise<void>) => handlers.set(event, handler),
      registerCapability: vi.fn(), registerCommand: vi.fn(),
    } as unknown as FelanExtensionAPI);
    expect(f.attach).toHaveBeenCalledTimes(2);
    const session = f.attach.mock.results[1]!.value as LocalMemoryAttachment;
    const daemon = f.attach.mock.results[0]!.value as LocalMemoryAttachment;
    const detached = vi.spyOn(daemon, 'detach');
    const disposed = vi.spyOn(f.shared.coordinator, 'dispose');
    await f.shared.release();
    await provider.settle('drain');
    await provider.dispose();
    expect(detached).toHaveBeenCalledOnce();
    expect(disposed).not.toHaveBeenCalled();
    expect(await session.status(f.cwd)).toMatchObject({ state: 'disabled' });
    await handlers.get('session_shutdown')!();
    expect(disposed).toHaveBeenCalledOnce();
  });

  it('escalates a drain to force settlement without discarding pending evidence', async () => {
    const f = await fixture();
    let entered = false;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    f.worker.prompt.mockImplementation(async () => { entered = true; await blocked; });
    f.worker.abort.mockImplementation(async () => { release(); });
    const store = await f.seed(f.cwd, 5);
    const provider = await f.create();
    await provider.activate();
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(provider.busy()).toBe(true);
    const draining = provider.settle('drain');
    await provider.settle('force');
    await draining;
    expect(f.worker.abort).toHaveBeenCalledOnce();
    expect(f.worker.dispose).toHaveBeenCalledOnce();
    expect(provider.busy()).toBe(false);
    expect(await store.pendingAcceptedUpdates()).toBe(5);
    expect(await store.readControl()).toMatchObject({ lastOutcome: { status: 'cancelled' } });
  });

  it('does not report busy for work owned by another coordinator attachment', async () => {
    const f = await fixture();
    const provider = await f.create({ projects: [f.cwd], discover: false });
    await provider.activate();
    const other = join(f.root, 'other');
    await f.seed(other, 5);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    f.worker.prompt.mockImplementation(async () => blocked);
    const session = f.shared.coordinator.attach({
      environment: { ...f.environment, openWorker: f.openWorker }, models: f.models, scheduling: true,
    });
    cleanups.push(async () => { release(); await session.detach(); });
    await session.status(other);
    await vi.waitFor(() => expect(f.worker.prompt).toHaveBeenCalledOnce());
    expect(session.busy()).toBe(true);
    expect(f.shared.coordinator.hasActiveWork()).toBe(true);
    expect(provider.busy()).toBe(false);
    release();
    await vi.waitFor(() => expect(session.busy()).toBe(false));
  });
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'felan-memory-daemon-')));
  roots.push(root);
  const cwd = join(root, 'workspace');
  const agentDir = join(root, 'agent');
  await mkdir(cwd);
  const paths = new Map<string, string>();
  const checkpoint = async (id: string): Promise<SessionCheckpointRef> => {
    const path = paths.get(id)!;
    const revision = await readFile(path, 'utf8');
    const manager = SessionManager.open(path);
    return { sessionId: id, revision, branch: manager.getLeafId(), transcriptDigest: digestActiveBranch(manager.getBranch()), byteLength: Buffer.byteLength(revision) };
  };
  const list = vi.fn<SessionsHistory['list']>(async () => ({ items: await Promise.all([...paths].map(async ([id, path]) => ({
    id, root: id, cwd: SessionManager.open(path).getCwd(), title: '', updatedAt: 0, state: 'closed' as const,
  }))) }));
  const readHistory = vi.fn<SessionsHistory['history']>(async id => ({ ...await checkpoint(id), entries: SessionManager.open(paths.get(id)!).getEntries() }));
  const history: SessionsHistory = {
    current: { id: 'host', root: 'host' },
    list,
    checkpoint,
    history: readHistory,
  };
  const runtime = new HostAgentRuntime(cwd, { pathAccess: 'host', sessionStorageRoot: join(root, 'storage'), agentStorageRoot: agentDir });
  const environment: MemoryContext = { runtime, sessions: history };
  const tools = ['read', 'ls', 'grep', 'edit', 'write', 'remove_memory_page'];
  const worker = {
    abort: vi.fn(async () => {}), bindExtensions: vi.fn(async () => {}),
    getActiveToolNames: () => tools, setActiveToolsByName: vi.fn(), subscribe: () => () => {},
    thinkingLevel: 'medium', messages: [{ role: 'assistant', stopReason: 'stop' }],
    prompt: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
  };
  const openWorker = vi.fn<HostMaintenance['openWorker']>(async () => worker as unknown as HostWorker);
  const sessions = vi.fn<HostMaintenance['sessions']>(() => history);
  const lifetime = new AbortController();
  const allowedModels = vi.fn<HostMaintenance['allowedModels']>(async () => undefined);
  const model = { provider: 'openai-codex', id: 'gpt-5.6-luna', input: ['text'] } as Model<Api>;
  const maintenance = { agentDir, sessions, openWorker, signal: lifetime.signal, allowedModels,
    modelRuntime: { getModel: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined } } as unknown as HostMaintenance;
  const models = { getAvailable: async () => [model] } as unknown as ModelsService;
  const shared = acquireSharedLocalMemoryCoordinator({ agentDir, recover: false });
  cleanups.push(() => shared.release());
  const attach = vi.spyOn(shared.coordinator, 'attach');
  const get = vi.fn();
  let count = 0;
  return { root, cwd, agentDir, environment, shared, attach, get, sessions, models, openWorker, worker, list, readHistory, lifetime, allowedModels,
    async create(options: Parameters<typeof createMemoryDaemonProvider>[0] = {}, withModels = true, waitForScan = true) {
      get.mockImplementation((contract: { key: string }) => contract.key === HOST_MAINTENANCE_SERVICE.key ? maintenance
        : contract.key === HOST_MODELS_SERVICE.key && withModels ? models : undefined);
      const provider = await createMemoryDaemonProvider(options).create({ services: { get } as ExtensionServiceAccess });
      cleanups.push(() => provider.dispose());
      if (!waitForScan) return provider;
      // Activation returns before the first project scan; status waits for that scan.
      const activate = provider.activate.bind(provider);
      const scanned = new WeakMap<Promise<void>, Promise<void>>();
      provider.activate = () => {
        const activation = activate();
        let waited = scanned.get(activation);
        if (!waited) {
          waited = activation.then(async () => { await provider.implementations[0]!.value.status(); });
          scanned.set(activation, waited);
        }
        return waited;
      };
      return provider;
    },
    async seed(projectCwd: string, updates: number) {
      await mkdir(projectCwd, { recursive: true });
      const store = new LocalMemoryStore(environment, agentDir, await resolveLocalMemoryProject(environment, projectCwd));
      await store.initialize();
      for (let index = 0; index <= updates; index++) {
        const id = `source-${count++}`;
        const path = join(projectCwd, `${id}.jsonl`);
        paths.set(id, path);
        await writeFile(path, [JSON.stringify({ type: 'session', version: 3, id, cwd: projectCwd, timestamp: new Date().toISOString() }),
          JSON.stringify({ type: 'message', id: 'entry', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Remember the project preference.' } }), ''].join('\n'));
        if (index < updates) await store.recordCheckpoint(createSessionCheckpoint(SessionManager.open(path))!);
      }
      return store;
    },
  };
}
