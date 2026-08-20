import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryStatus } from '@felan-ai/ext-memory';
import type { ExtensionContext, FelanExtensionAPI } from '@felan-ai/agent-core';
import { ModelRuntime } from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalMemoryControlExtension } from '../src/memory/control.js';
import { LocalMemoryCoordinator } from '../src/memory/coordinator.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('local memory controls', () => {
  it('reports status and persists enable/disable commands without requiring a restart to stop processing', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await mkdir(cwd, { recursive: true });
    const coordinator = new LocalMemoryCoordinator({
      agentDir,
      modelRuntime: await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null }),
      recover: false,
    });
    const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
    const notifications: string[] = [];
    const extension = createLocalMemoryControlExtension({ coordinator, agentDir });
    extension({
      registerCommand: (name, command) => commands.set(name, command.handler),
      on: () => {},
    } as unknown as FelanExtensionAPI);
    const ctx = {
      cwd,
      mode: 'tui',
      hasUI: true,
      ui: {
        notify: (message: string) => notifications.push(message),
        setStatus: () => {},
      },
    } as unknown as ExtensionContext;

    await commands.get('memory')!('status', ctx);
    expect(notifications[0]).toContain('Local memory: enabled');
    await commands.get('memory')!('disable', ctx);
    expect(coordinator.isEnabled()).toBe(false);
    expect(JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')))
      .toMatchObject({ felanTui: { memoryProcessing: false } });
    await commands.get('memory')!('enable', ctx);
    expect(coordinator.isEnabled()).toBe(true);
    expect(JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')))
      .toMatchObject({ felanTui: { memoryProcessing: true } });
    await coordinator.dispose();
  });

  it('refreshes the footer when memory status changes and stops after shutdown', async () => {
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
    const setStatus = vi.fn();
    let pendingCheckpoints = 28;
    let statusListener: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const coordinator = {
      status: vi.fn(async () => ({
        enabled: true,
        state: 'idle' as const,
        pendingCheckpoints,
      })),
      subscribeStatusChanges: vi.fn((listener: () => void) => {
        statusListener = listener;
        return unsubscribe;
      }),
    } as unknown as LocalMemoryCoordinator;
    const extension = createLocalMemoryControlExtension({ coordinator, agentDir: '/unused' });
    extension({
      registerCommand: () => {},
      on: (name, handler) => handlers.set(name, handler),
    } as unknown as FelanExtensionAPI);
    const ctx = {
      cwd: '/workspace',
      mode: 'tui',
      hasUI: true,
      sessionManager: { getSessionId: () => 'session-1' },
      ui: { setStatus },
    } as unknown as ExtensionContext;

    await handlers.get('session_start')!({}, ctx);
    expect(setStatus).toHaveBeenLastCalledWith('memory', 'Memory: 28 pending');

    pendingCheckpoints = 5;
    statusListener!();
    await vi.waitFor(() => expect(setStatus).toHaveBeenLastCalledWith('memory', 'Memory: 5 pending'));

    pendingCheckpoints = 0;
    statusListener!();
    await vi.waitFor(() => expect(setStatus).toHaveBeenLastCalledWith('memory', undefined));

    await handlers.get('session_shutdown')!({}, ctx);
    expect(unsubscribe).toHaveBeenCalledOnce();
    const callsAfterShutdown = setStatus.mock.calls.length;
    statusListener!();
    await Promise.resolve();
    expect(setStatus).toHaveBeenCalledTimes(callsAfterShutdown);
  });

  it('ignores a stale shutdown after a replacement session starts', async () => {
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
    const listeners: Array<() => void> = [];
    const unsubscribes = [vi.fn(), vi.fn()];
    let pendingCheckpoints = 3;
    const coordinator = {
      status: vi.fn(async () => ({
        enabled: true,
        state: 'idle' as const,
        pendingCheckpoints,
      })),
      subscribeStatusChanges: vi.fn((listener: () => void) => {
        listeners.push(listener);
        return unsubscribes[listeners.length - 1]!;
      }),
    } as unknown as LocalMemoryCoordinator;
    createLocalMemoryControlExtension({ coordinator, agentDir: '/unused' })({
      registerCommand: () => {},
      on: (name, handler) => handlers.set(name, handler),
    } as unknown as FelanExtensionAPI);
    const first = memoryContext('session-1');
    const second = memoryContext('session-2');

    await handlers.get('session_start')!({}, first.ctx);
    await handlers.get('session_start')!({}, second.ctx);
    expect(unsubscribes[0]).toHaveBeenCalledOnce();

    await handlers.get('session_shutdown')!({}, first.ctx);
    expect(unsubscribes[1]).not.toHaveBeenCalled();

    pendingCheckpoints = 2;
    listeners[1]!();
    await vi.waitFor(() => expect(second.setStatus).toHaveBeenLastCalledWith('memory', 'Memory: 2 pending'));

    await handlers.get('session_shutdown')!({}, second.ctx);
    expect(unsubscribes[1]).toHaveBeenCalledOnce();
  });

  it('does not let an older refresh overwrite a newer pending count', async () => {
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
    let statusListener: (() => void) | undefined;
    const older = deferred<MemoryStatus>();
    const newer = deferred<MemoryStatus>();
    const coordinator = {
      status: vi.fn()
        .mockResolvedValueOnce(memoryStatus(28))
        .mockImplementationOnce(() => older.promise)
        .mockImplementationOnce(() => newer.promise),
      subscribeStatusChanges: vi.fn((listener: () => void) => {
        statusListener = listener;
        return () => {};
      }),
    } as unknown as LocalMemoryCoordinator;
    createLocalMemoryControlExtension({ coordinator, agentDir: '/unused' })({
      registerCommand: () => {},
      on: (name, handler) => handlers.set(name, handler),
    } as unknown as FelanExtensionAPI);
    const { ctx, setStatus } = memoryContext('session-1');
    await handlers.get('session_start')!({}, ctx);

    statusListener!();
    statusListener!();
    newer.resolve(memoryStatus(5));
    await vi.waitFor(() => expect(setStatus).toHaveBeenLastCalledWith('memory', 'Memory: 5 pending'));
    older.resolve(memoryStatus(28));
    await older.promise;
    await Promise.resolve();

    expect(setStatus).toHaveBeenLastCalledWith('memory', 'Memory: 5 pending');
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-memory-control-'));
  temporaryPaths.push(path);
  return path;
}

function memoryContext(sessionId: string): { ctx: ExtensionContext; setStatus: ReturnType<typeof vi.fn> } {
  const setStatus = vi.fn();
  return {
    ctx: {
      cwd: '/workspace',
      mode: 'tui',
      hasUI: true,
      sessionManager: { getSessionId: () => sessionId },
      ui: { setStatus },
    } as unknown as ExtensionContext,
    setStatus,
  };
}

function memoryStatus(pendingCheckpoints: number): MemoryStatus {
  return { enabled: true, state: 'idle', pendingCheckpoints };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
