import { expect, it, vi } from 'vitest';
import { RUNTIME_LIFETIME_SERVICE, type ExtensionContext, type FelanExtensionAPI, type RuntimeLifecycle } from '@felan-ai/agent-core';
import { createCodebaseMemoryExtension } from '../src/runtime.js';
import { envelope, MemoryRuntime, result } from './test-runtime.js';

it('retains active indexing through the runtime lifetime service and releases it before shutdown', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runtime = new MemoryRuntime('host', true, async () => {
    await gate;
    return result(envelope({ project: 'fixture', projects: [] }));
  });
  let lifecycle!: RuntimeLifecycle;
  const unregister = vi.fn();
  const handlers = new Map<string, (event: unknown, context: ExtensionContext) => unknown>();
  const api = {
    runtime, config: {},
    services: { get: (contract: { key: string }) => contract.key === RUNTIME_LIFETIME_SERVICE.key
      ? { register: (value: RuntimeLifecycle) => { lifecycle = value; return unregister; } } : undefined },
    registerTool: vi.fn(), registerCapability: vi.fn(), registerCommand: vi.fn(),
    on: (name: string, handler: (event: unknown, context: ExtensionContext) => unknown) => handlers.set(name, handler),
  } as unknown as FelanExtensionAPI;
  const context = { hasUI: false, ui: { setStatus: vi.fn() } } as unknown as ExtensionContext;
  await createCodebaseMemoryExtension()(api);
  expect(lifecycle.busy()).toBe(false);
  handlers.get('session_start')!({}, context);
  await vi.waitFor(() => expect(runtime.shellCalls.length).toBeGreaterThan(0));
  expect(lifecycle.busy()).toBe(true);
  let settled = false;
  const settling = lifecycle.settle('drain').then(() => { settled = true; });
  try {
    await Promise.resolve(); expect(settled).toBe(false);
  } finally { release(); }
  await settling;
  expect(lifecycle.busy()).toBe(false);
  expect(unregister).toHaveBeenCalledOnce();
  await lifecycle.dispose();
  await handlers.get('session_shutdown')!({}, context);
  expect(unregister).toHaveBeenCalledOnce();
});
