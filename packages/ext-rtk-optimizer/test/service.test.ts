import { expect, it, vi } from 'vitest';
import {
  RUNTIME_DEPENDENCIES_SERVICE, createExtensionServiceAccess, createFelanServiceRegistry,
  type ExtensionContext, type FelanExtensionAPI, type RuntimeDependenciesService,
} from '@felan-ai/agent-core';
import extension from '../src/index.js';
import { MemoryRuntime, result } from './test-runtime.js';

async function fixture(provider?: RuntimeDependenciesService) {
  let available = false;
  const runtime = new MemoryRuntime(async (_command, args) => available && args.includes('--version')
    ? result('rtk 0.45.0') : result('', 127, 'missing'));
  const registry = createFelanServiceRegistry();
  if (provider) registry.set(RUNTIME_DEPENDENCIES_SERVICE, provider);
  const notify = vi.fn(async (_value: { text: string; level: string }) => {});
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const handlers = new Map<string, Array<() => Promise<void>>>();
  await extension({ runtime, config: {}, services: createExtensionServiceAccess(registry, extension.serviceRequirements!), ui: { notify },
    registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, command),
    on: (name: string, handler: () => Promise<void>) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
  } as unknown as FelanExtensionAPI);
  return { runtime, notify, enable: () => { available = true; },
    command: (args: string, signal?: AbortSignal) => commands.get('rtk')!.handler(args, {
      signal, get ui() { throw new Error('Native UI must not grant installation'); },
    } as unknown as ExtensionContext),
    shutdown: async () => { for (const handler of handlers.get('session_shutdown') ?? []) await handler(); },
  };
}

it('requires no setup provider for normal inspection but disables install when absent', async () => {
  expect(extension.serviceRequirements).toEqual({ optional: [RUNTIME_DEPENDENCIES_SERVICE] });
  const h = await fixture();
  await h.command('install');
  expect(h.runtime.execCalls).toEqual([]);
  expect(h.notify).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('no runtime-dependencies provider') }));
  await h.command('show');
  expect(h.notify).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('rtk=missing') }));
  await h.command('verify');
  expect(h.runtime.execCalls.length).toBeGreaterThan(0);
  expect(h.runtime.execCalls.every(call => call.args.includes('--version'))).toBe(true);
  await h.shutdown();
});

it('delegates explicit setup and refreshes the running optimizer status after host installation', async () => {
  let h!: Awaited<ReturnType<typeof fixture>>;
  const install = vi.fn<RuntimeDependenciesService['install']>(async () => { h.enable(); return { status: 'installed' }; });
  h = await fixture({ install });
  expect(install).not.toHaveBeenCalled();
  expect(h.runtime.execCalls).toEqual([]);
  await h.command('verify');
  await h.command('install');
  expect(install).toHaveBeenCalledExactlyOnceWith({ id: 'rtk' }, { signal: expect.any(AbortSignal) });
  expect(h.runtime.execCalls.every(call => call.args.includes('--version'))).toBe(true);
  expect(h.notify).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('installed successfully') }));
  await h.command('show');
  expect(h.notify).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('rtk=available') }));
  await h.shutdown();
});

it.each(['cancelled', 'unavailable'] as const)('does not probe or install after a %s decision', async status => {
  const install = vi.fn<RuntimeDependenciesService['install']>(async () => ({ status, message: 'Host denied setup.' }));
  const h = await fixture({ install });
  await h.command('install');
  expect(h.runtime.execCalls).toEqual([]);
  expect(h.notify).toHaveBeenLastCalledWith({ text: 'Host denied setup.', level: 'warning' });
  await h.shutdown();
});

it.each([false, true])('retains setup until host settlement (abort rejection: %s)', async rejecting => {
  let finish!: (value: { status: 'cancelled'; message: string }) => void;
  let fail!: (error: Error) => void;
  const install = vi.fn<RuntimeDependenciesService['install']>(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  const h = await fixture({ install });
  const request = h.command('install');
  const signal = install.mock.calls[0]![1]!.signal!;
  let stopped = false;
  const stopping = h.shutdown().then(() => { stopped = true; });
  expect(signal.aborted).toBe(true);
  expect(stopped).toBe(false);
  if (rejecting) fail(new DOMException('Cancelled by host.', 'AbortError'));
  else finish({ status: 'cancelled', message: 'Cancelled by host.' });
  await request; await stopping;
  await expect(h.command('install')).rejects.toMatchObject({ name: 'AbortError' });
  expect(install).toHaveBeenCalledOnce();
});

it('releases setup admission after a provider failure without invoking an installer', async () => {
  const install = vi.fn<RuntimeDependenciesService['install']>().mockRejectedValueOnce(new Error('Provider failed'))
    .mockResolvedValue({ status: 'cancelled', message: 'Cancelled by host.' });
  const h = await fixture({ install });
  await expect(h.command('install')).rejects.toThrow('Provider failed');
  await h.command('install');
  expect(install).toHaveBeenCalledTimes(2);
  expect(h.runtime.execCalls).toEqual([]);
  await h.shutdown();
});
