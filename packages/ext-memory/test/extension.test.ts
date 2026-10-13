import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { HostAgentRuntime, HOST_WORKERS_SERVICE, MODELS_SERVICE, RUNTIME_LIFETIME_SERVICE, SESSIONS_SERVICE, SessionManager, type ExtensionContext, type FelanExtensionAPI } from '@felan-ai/agent-core';
import extension from '../src/extension.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

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
