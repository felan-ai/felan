import { expect, it, vi } from 'vitest';
import {
  RUNTIME_DEPENDENCIES_SERVICE, createExtensionServiceAccess, createFelanServiceRegistry,
  type AgentRuntime, type ExtensionContext, type FelanExtensionAPI, type RuntimeDependenciesService,
} from '@felan-ai/agent-core';
import extension from '../src/index.js';

function fixture(provider?: RuntimeDependenciesService) {
  let available = false;
  const files = new Map<string, Uint8Array>();
  const exec = vi.fn(async (_command: string, args: readonly string[]) => {
    if (args.includes('--version')) return available
      ? { stdout: 'markitdown 0.1.7', stderr: '', code: 0, killed: false }
      : { stdout: '', stderr: 'missing', code: 127, killed: false };
    const output = args.indexOf('-o');
    if (available && output >= 0) {
      files.set(args[output + 1]!, new TextEncoder().encode('Felan MarkItDown PDF probe'));
      return { stdout: '', stderr: '', code: 0, killed: false };
    }
    throw new Error('Unexpected execution');
  });
  const runtime = { kind: 'daytona', cwd: '/work', exec, storage: (scope: string) => {
    const root = `/${scope}`;
    return { root, mkdir: async () => {},
      readFile: async (path: string) => { const value = files.get(`${root}/${path}`); if (!value) throw new Error('missing'); return value; },
      writeFile: async (path: string, value: Uint8Array) => { files.set(`${root}/${path}`, value); },
      remove: async (path: string) => { files.delete(`${root}/${path}`); },
    };
  } } as unknown as AgentRuntime;
  const registry = createFelanServiceRegistry();
  if (provider) registry.set(RUNTIME_DEPENDENCIES_SERVICE, provider);
  const notify = vi.fn(async (_value: { text: string; level: string }) => {});
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const handlers = new Map<string, Array<() => Promise<void>>>();
  const capability = vi.fn();
  extension({ runtime, services: createExtensionServiceAccess(registry, extension.serviceRequirements!), ui: { notify },
    registerCapability: capability, events: { on: vi.fn() },
    registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, command),
    on: (name: string, handler: () => Promise<void>) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
  } as unknown as FelanExtensionAPI);
  return { exec, notify, capability, files, enable: () => { available = true; },
    command: (args: string, signal?: AbortSignal) => commands.get('markitdown')!.handler(args, {
      signal, get ui() { throw new Error('Native UI must not grant installation'); },
    } as unknown as ExtensionContext),
    shutdown: async () => { for (const handler of handlers.get('session_shutdown') ?? []) await handler(); },
  };
}

it('declares optional setup authority and keeps status/capability available without it', async () => {
  expect(extension.serviceRequirements).toEqual({ optional: [RUNTIME_DEPENDENCIES_SERVICE] });
  const h = fixture();
  await h.command('install');
  expect(h.exec).not.toHaveBeenCalled();
  expect(h.notify).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('no runtime-dependencies provider') }));
  await h.command('');
  expect(h.exec).toHaveBeenCalled();
  expect(h.capability).toHaveBeenCalledOnce();
  expect(h.notify).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('Converted: .pdf') }));
});

it('routes only an explicit install to host authority and rechecks availability afterwards', async () => {
  let h!: ReturnType<typeof fixture>;
  const install = vi.fn<RuntimeDependenciesService['install']>(async () => { h.enable(); return { status: 'installed' }; });
  h = fixture({ install });
  expect(install).not.toHaveBeenCalled();
  await h.command('');
  expect(install).not.toHaveBeenCalled();
  await h.command('install');
  expect(install).toHaveBeenCalledExactlyOnceWith({ id: 'markitdown' }, { signal: expect.any(AbortSignal) });
  expect(h.notify).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('MarkItDown installed') }));
  expect(h.files.size).toBe(0);
});

it.each(['cancelled', 'unavailable'] as const)('keeps %s separate from installation success', async status => {
  const install = vi.fn<RuntimeDependenciesService['install']>(async () => ({ status, message: 'Host denied setup.' }));
  const h = fixture({ install });
  await h.command('install');
  expect(h.exec).not.toHaveBeenCalled();
  expect(h.notify).toHaveBeenLastCalledWith({ text: 'Host denied setup.', level: 'warning' });
});

it.each([false, true])('joins in-flight setup at shutdown (abort rejection: %s)', async rejecting => {
  let finish!: (value: { status: 'cancelled'; message: string }) => void;
  let fail!: (error: Error) => void;
  const install = vi.fn<RuntimeDependenciesService['install']>(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  const h = fixture({ install });
  const caller = new AbortController();
  const request = h.command('install', caller.signal);
  const signal = install.mock.calls[0]![1]!.signal!;
  caller.abort();
  expect(signal.aborted).toBe(true);
  let stopped = false;
  const stopping = h.shutdown().then(() => { stopped = true; });
  expect(stopped).toBe(false);
  if (rejecting) fail(new DOMException('Cancelled by host.', 'AbortError'));
  else finish({ status: 'cancelled', message: 'Cancelled by host.' });
  await request; await stopping;
  expect(h.exec).not.toHaveBeenCalled();
  await expect(h.command('install')).rejects.toThrow('cancelled by session shutdown');
  expect(install).toHaveBeenCalledOnce();
});

it('releases setup admission after a provider failure without invoking an installer', async () => {
  const install = vi.fn<RuntimeDependenciesService['install']>().mockRejectedValueOnce(new Error('Provider failed'))
    .mockResolvedValue({ status: 'cancelled', message: 'Cancelled by host.' });
  const h = fixture({ install });
  await expect(h.command('install')).rejects.toThrow('Provider failed');
  await h.command('install');
  expect(install).toHaveBeenCalledTimes(2);
  expect(h.exec).not.toHaveBeenCalled();
});
