import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { HostAgentRuntime, HOST_WORKERS_SERVICE, MODELS_SERVICE, RUNTIME_LIFETIME_SERVICE, SESSIONS_SERVICE, SessionManager, type ExtensionContext, type FelanExtensionAPI, type RuntimeLifecycle } from '@felan-ai/agent-core';
import extension from '../src/extension.js';
import { digestActiveBranch } from '../src/index.js';
import type { LocalMemoryAttachment } from '../src/local/coordinator.js';
import { acquireSharedLocalMemoryCoordinator } from '../src/local/shared.js';

const directories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
const pendingWork: Array<Promise<PromiseSettledResult<unknown>[]>> = [];
afterEach(async () => {
  const results: PromiseSettledResult<unknown>[] = await Promise.allSettled(cleanups.splice(0).map(cleanup => cleanup()));
  results.push(...(await Promise.all(pendingWork.splice(0))).flat());
  vi.restoreAllMocks();
  results.push(...await Promise.allSettled(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))));
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, 'Memory extension fixture cleanup failed');
});

it.each(['worker', 'lifetime', 'both', 'files'])('loads and reports disabled scheduling without the %s capability', async missing => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-capabilities-')); directories.push(directory);
  const runtime = new HostAgentRuntime(directory, { pathAccess: 'host', sessionStorageRoot: join(directory, 'session'), agentStorageRoot: join(directory, 'agent') });
  if (missing === 'files') Object.defineProperty(runtime, 'files', { value: undefined });
  const manager = SessionManager.inMemory(directory);
  const handlers = new Map<string, Array<(event: unknown, context: ExtensionContext) => unknown>>();
  const commands = new Map<string, { handler: (args: string, context: ExtensionContext) => Promise<void> }>();
  const getAvailable = vi.fn();
  const openWorker = vi.fn();
  const status = vi.fn(async () => {});
  const notify = vi.fn(async () => {});
  const api = {
    runtime, agentDir: join(directory, 'agent'),
    services: { get(contract: { key: string }) {
      if (contract.key === MODELS_SERVICE.key) return { getAvailable };
      if (contract.key === SESSIONS_SERVICE.key) return { current: { id: manager.getSessionId(), root: manager.getSessionId() } };
      if (contract.key === HOST_WORKERS_SERVICE.key && missing === 'lifetime') return openWorker;
      if (contract.key === RUNTIME_LIFETIME_SERVICE.key && missing === 'worker') return { register: () => () => {} };
      return undefined;
    } },
    ui: { status, notify, removeStatus: vi.fn(async () => {}) },
    registerCommand: (name: string, command: { handler: (args: string, context: ExtensionContext) => Promise<void> }) => commands.set(name, command),
    registerCapability: vi.fn(), sendMessage: vi.fn(),
    on: (name: string, handler: (event: unknown, context: ExtensionContext) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
  } as unknown as FelanExtensionAPI;
  const context = { cwd: directory, sessionManager: manager } as unknown as ExtensionContext;
  extension(api);
  try {
    for (const handler of handlers.get('session_start') ?? []) await handler({}, context);
    expect(status).toHaveBeenCalledWith(expect.objectContaining({ fallback: missing === 'files' ? 'Memory unavailable' : 'Memory: disabled' }));
    await commands.get('memory')!.handler('run', context);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining(missing === 'files' ? 'does not provide runtime files' : 'Dream scheduling is unavailable') })));
    expect(getAvailable).not.toHaveBeenCalled();
    expect(openWorker).not.toHaveBeenCalled();
  } finally {
    for (const handler of handlers.get('session_shutdown') ?? []) await handler({}, context);
  }
});

it('shares a coordinator between root extension sessions and releases it through their lifetimes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-extension-shared-')); directories.push(directory);
  const agentDir = join(directory, 'agent');
  let entered = false;
  let signal: AbortSignal | undefined;
  const shared = acquireSharedLocalMemoryCoordinator({ agentDir, recover: false, dreamRunner: async input => {
    signal = input.signal;
    const cancelled = new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }));
    input.signal.throwIfAborted();
    entered = true;
    await cancelled;
    return input.baseSnapshot;
  } });
  cleanups.push(() => shared.release());
  const attach = vi.spyOn(shared.coordinator, 'attach');
  const dispose = vi.spyOn(shared.coordinator, 'dispose');
  const first = await loadRootSession(directory, 'root-a');
  const second = await loadRootSession(directory, 'root-b');
  expect(attach).toHaveBeenCalledTimes(2);
  expect(attach.mock.calls.map(([options]) => options.scheduling)).toEqual([true, true]);
  const attachmentA = attach.mock.results[0]!.value as LocalMemoryAttachment;
  const attachmentB = attach.mock.results[1]!.value as LocalMemoryAttachment;
  expect(attachmentA).not.toBe(attachmentB);
  await shared.release();
  expect(dispose).not.toHaveBeenCalled();

  await first.emit('session_start');
  await second.emit('session_start');
  await first.emit('agent_settled');
  expect(await attachmentA.status(directory)).toMatchObject({ pendingCheckpoints: 1 });
  expect(await attachmentB.status(directory)).toMatchObject({ pendingCheckpoints: 1 });
  await vi.waitFor(() => {
    expect(first.status).toHaveBeenCalledWith(expect.objectContaining({ fallback: 'Memory: 1 pending' }));
    expect(second.status).toHaveBeenCalledWith(expect.objectContaining({ fallback: 'Memory: 1 pending' }));
  }, { interval: 10 });

  const running = attachmentA.runNow(directory);
  pendingWork.push(Promise.allSettled([running]));
  await vi.waitFor(() => expect(entered).toBe(true), { interval: 10 });
  expect(first.lifecycle.busy()).toBe(true);
  expect(second.lifecycle.busy()).toBe(false);
  const settleA = vi.spyOn(attachmentA, 'settle');
  const settleB = vi.spyOn(attachmentB, 'settle');
  await second.lifecycle.settle('drain');
  expect(settleB).toHaveBeenCalledWith('drain');
  expect(signal?.aborted).toBe(false);
  await first.lifecycle.settle('force');
  expect(settleA).toHaveBeenCalledWith('force');
  await running;
  expect(signal?.aborted).toBe(true);
  expect(first.lifecycle.busy()).toBe(false);
  expect(second.lifecycle.busy()).toBe(false);
  expect(await attachmentB.status(directory)).toMatchObject({ pendingCheckpoints: 1, consecutiveFailures: 0 });

  const detachA = vi.spyOn(attachmentA, 'detach');
  const detachB = vi.spyOn(attachmentB, 'detach');
  const closingA = first.lifecycle.dispose();
  expect(first.lifecycle.dispose()).toBe(closingA);
  await closingA;
  await first.emit('session_shutdown');
  expect(detachA).toHaveBeenCalledOnce();
  expect(first.unregister).toHaveBeenCalledOnce();
  expect(dispose).not.toHaveBeenCalled();
  const stillShared = acquireSharedLocalMemoryCoordinator({ agentDir });
  cleanups.push(() => stillShared.release());
  expect(stillShared.coordinator).toBe(shared.coordinator);
  await stillShared.release();

  await second.emit('session_shutdown');
  await second.lifecycle.dispose();
  expect(detachB).toHaveBeenCalledOnce();
  expect(second.unregister).toHaveBeenCalledOnce();
  expect(dispose).toHaveBeenCalledOnce();
  const fresh = acquireSharedLocalMemoryCoordinator({ agentDir, recover: false });
  cleanups.push(() => fresh.release());
  expect(fresh.coordinator).not.toBe(shared.coordinator);
  const freshAttach = vi.spyOn(fresh.coordinator, 'attach');
  const freshDispose = vi.spyOn(fresh.coordinator, 'dispose');
  const third = await loadRootSession(directory, 'root-c');
  expect(freshAttach).toHaveBeenCalledOnce();
  expect(attach).toHaveBeenCalledTimes(2);
  await fresh.release();
  expect(freshDispose).not.toHaveBeenCalled();
  await third.emit('session_start');
  const attachmentC = freshAttach.mock.results[0]!.value as LocalMemoryAttachment;
  expect(await attachmentC.status(directory)).toMatchObject({ pendingCheckpoints: 1 });
  await third.emit('session_shutdown');
  expect(third.unregister).toHaveBeenCalledOnce();
  expect(freshDispose).toHaveBeenCalledOnce();
});

it('releases a failed session attachment and shared coordinator when lifetime registration throws', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-extension-registration-')); directories.push(directory);
  const agentDir = join(directory, 'agent');
  const dreamRunner = vi.fn(async () => { throw new Error('Failed session scheduled memory processing'); });
  const shared = acquireSharedLocalMemoryCoordinator({ agentDir, recover: false, debounceMs: 60_000, dreamRunner });
  cleanups.push(() => shared.release());
  const attach = shared.coordinator.attach.bind(shared.coordinator);
  const attachments = vi.spyOn(shared.coordinator, 'attach').mockImplementation(options => {
    const attachment = attach(options);
    vi.spyOn(attachment, 'detach');
    return attachment;
  });
  const dispose = vi.spyOn(shared.coordinator, 'dispose');
  const error = new Error('Session open was aborted');

  await expect(loadRootSession(directory, 'root-failed', error)).rejects.toBe(error);
  expect(attachments).toHaveBeenCalledOnce();
  const failed = attachments.mock.results[0]!.value as LocalMemoryAttachment;
  expect(failed.detach).toHaveBeenCalledOnce();
  await vi.mocked(failed.detach).mock.results[0]!.value;

  const reader = shared.coordinator.attach({ ...attachments.mock.calls[0]![0], scheduling: false });
  cleanups.push(() => reader.detach());
  const sessionFile = join(directory, 'root-failed.jsonl');
  const manager = SessionManager.open(sessionFile);
  await reader.recordCheckpoint(directory, { sessionId: manager.getSessionId(), sessionFile,
    leafId: manager.getLeafId(), transcriptDigest: digestActiveBranch(manager.getBranch()) });
  await failed.runNow(directory);
  expect(await reader.status(directory)).toMatchObject({ pendingCheckpoints: 1, consecutiveFailures: 0 });
  expect(dreamRunner).not.toHaveBeenCalled();
  await reader.detach();
  await shared.release();
  expect(dispose).toHaveBeenCalledOnce();

  const fresh = acquireSharedLocalMemoryCoordinator({ agentDir, recover: false });
  cleanups.push(() => fresh.release());
  expect(fresh.coordinator).not.toBe(shared.coordinator);
});

async function loadRootSession(directory: string, id: string, registrationError?: Error) {
  const sessionFile = join(directory, `${id}.jsonl`);
  await writeFile(sessionFile, [JSON.stringify({ type: 'session', version: 3, id, cwd: directory }),
    JSON.stringify({ type: 'message', id: 'leaf', parentId: null, timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'Keep memory attached to this project.' } }), ''].join('\n'));
  const manager = SessionManager.open(sessionFile);
  const runtime = new HostAgentRuntime(directory, { pathAccess: 'host', sessionStorageRoot: join(directory, 'storage', id), agentStorageRoot: join(directory, 'agent') });
  const handlers = new Map<string, Array<(event: unknown, context: ExtensionContext) => unknown>>();
  const status = vi.fn(async () => {});
  const unregister = vi.fn();
  const register = vi.fn((_lifecycle: RuntimeLifecycle) => {
    if (registrationError) throw registrationError;
    return unregister;
  });
  const checkpoint = async (sessionId: string) => {
    const path = join(directory, `${sessionId}.jsonl`);
    const revision = await readFile(path, 'utf8');
    const source = SessionManager.open(path);
    return { sessionId, revision, branch: source.getLeafId(), transcriptDigest: digestActiveBranch(source.getBranch()), byteLength: Buffer.byteLength(revision) };
  };
  const sessions = { current: { id, root: id }, list: async () => ({ items: [] }), checkpoint,
    history: async (sessionId: string) => ({ ...await checkpoint(sessionId), entries: SessionManager.open(join(directory, `${sessionId}.jsonl`)).getEntries() }) };
  const api = {
    runtime, agentDir: join(directory, 'agent'),
    services: { get(contract: { key: string }) {
      if (contract.key === MODELS_SERVICE.key) return { getAvailable: vi.fn() };
      if (contract.key === SESSIONS_SERVICE.key) return sessions;
      if (contract.key === HOST_WORKERS_SERVICE.key) return vi.fn();
      if (contract.key === RUNTIME_LIFETIME_SERVICE.key) return { register };
      return undefined;
    } },
    ui: { status, notify: vi.fn(async () => {}), removeStatus: vi.fn(async () => {}) },
    registerCommand: vi.fn(), registerCapability: vi.fn(), sendMessage: vi.fn(),
    on: (name: string, handler: (event: unknown, context: ExtensionContext) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
  } as unknown as FelanExtensionAPI;
  const context = { cwd: directory, sessionManager: manager } as unknown as ExtensionContext;
  const emit = async (name: string) => {
    for (const handler of handlers.get(name) ?? []) await handler({}, context);
  };
  cleanups.push(() => emit('session_shutdown'));
  extension(api);
  expect(register).toHaveBeenCalledOnce();
  return { emit, status, unregister, lifecycle: register.mock.calls[0]![0] };
}
