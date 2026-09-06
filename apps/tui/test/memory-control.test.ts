import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  it('does not expose runtime enable or disable commands', async () => {
    const handlers = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
    const notify = vi.fn();
    const coordinator = {
      status: vi.fn(async () => ({ enabled: true, state: 'idle' as const, pendingCheckpoints: 0 })),
      subscribeStatusChanges: vi.fn(() => () => {}),
    } as unknown as LocalMemoryCoordinator;
    createLocalMemoryControlExtension({ coordinator, agentDir: '/unused' })({
      registerCommand: (name, command) => handlers.set(name, command.handler),
      on: () => {},
    } as unknown as FelanExtensionAPI);

    await handlers.get('memory')!('disable', { cwd: '/workspace', ui: { notify } } as unknown as ExtensionContext);

    expect(notify).toHaveBeenCalledWith('Usage: /memory status|run|runs [id|latest]|retry|open', 'warning');
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

  it('defers the startup warning until automatic-disable control becomes readable', async () => {
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
    let statusListener: (() => void) | undefined;
    let readable = false;
    const coordinator = {
      status: vi.fn(async () => readable ? {
        enabled: false,
        state: 'disabled' as const,
        pendingCheckpoints: 1,
        memoryFingerprint: '1'.repeat(64),
        consecutiveFailures: 3,
        autoDisabled: { runId: 'run-3', at: '2026-09-01T12:00:00.000Z', reason: 'Three attempts failed' },
      } : {
        enabled: true,
        state: 'error' as const,
        pendingCheckpoints: 0,
        message: 'Local memory storage is unavailable',
      }),
      subscribeStatusChanges: vi.fn((listener: () => void) => {
        statusListener = listener;
        return () => {};
      }),
    } as unknown as LocalMemoryCoordinator;
    createLocalMemoryControlExtension({ coordinator, agentDir: '/unused' })({
      registerCommand: () => {},
      on: (name, handler) => handlers.set(name, handler),
    } as unknown as FelanExtensionAPI);
    const current = memoryContext('session-1');
    await handlers.get('session_start')!({}, current.ctx);
    expect(current.notify).not.toHaveBeenCalled();

    readable = true;
    statusListener!();
    await vi.waitFor(() => expect(current.notify).toHaveBeenCalledOnce());
    statusListener!();
    await Promise.resolve();
    expect(current.notify).toHaveBeenCalledOnce();
  });

});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-memory-control-'));
  temporaryPaths.push(path);
  return path;
}

function memoryContext(sessionId: string, cwd = '/workspace'): {
  ctx: ExtensionContext;
  setStatus: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
} {
  const setStatus = vi.fn();
  const notify = vi.fn();
  return {
    ctx: {
      cwd,
      mode: 'tui',
      hasUI: true,
      sessionManager: { getSessionId: () => sessionId },
      ui: { setStatus, notify },
    } as unknown as ExtensionContext,
    setStatus,
    notify,
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
