import { expect, it, vi } from 'vitest';
import type { ExtensionContext, FelanExtensionAPI } from '@felan-ai/agent-core';
import { createMemoryControlExtension } from '../src/memory/control.js';
import type { LocalMemoryCoordinator } from '../src/memory/coordinator.js';

it('clears status before joining a pending view so a later session cannot be cleared by stale shutdown', async () => {
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  let command!: (args: string, ctx: ExtensionContext) => Promise<void>;
  let release!: () => void; let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { entered = resolve; });
  const setStatus = vi.fn(); const ctx = { cwd: '/fixture', hasUI: true, mode: 'print',
    sessionManager: { getSessionId: () => 'session' }, ui: { setStatus, notify: vi.fn() } } as unknown as ExtensionContext;
  const coordinator = { status: async () => ({ enabled: true, state: 'idle', pendingCheckpoints: 0 }),
    subscribeStatusChanges: () => () => {} } as unknown as LocalMemoryCoordinator;
  createMemoryControlExtension({ coordinator, agentDir: '/fixture', presentation: {
    isInteractive: () => true, async openDirectory() {}, showHistory() { entered(); return held; },
  } })({ registerCommand(_name: string, value: { handler: typeof command }) { command = value.handler; },
    on(name: string, handler: (event: unknown, context: ExtensionContext) => unknown) { events.set(name, handler); } } as unknown as FelanExtensionAPI);
  await events.get('session_start')!({}, ctx);
  const running = command('', ctx); await ready;
  const before = setStatus.mock.calls.length;
  const shutdown = events.get('session_shutdown')!({}, ctx) as Promise<void>;
  try { expect(setStatus).toHaveBeenCalledTimes(before + 1); expect(setStatus).toHaveBeenLastCalledWith('memory', undefined); }
  finally { release(); await Promise.all([running, shutdown]); }
});
