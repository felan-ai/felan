import type { ExtensionContext, FelanExtensionAPI } from '@felan-ai/agent-core';
import type { Component, TUI } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import powerlineExtension from '../src/index.js';
import type { FooterDataLike } from '../src/segments.js';

describe('powerline lifecycle', () => {
  it.each(['rpc', 'json', 'print'] as const)('is headless-safe in %s mode', async (mode) => {
    const harness = extensionHarness();
    powerlineExtension(harness.pi);
    const ctx = extensionContext(mode);

    await harness.emit('session_start', {}, ctx.value);
    await harness.emit('agent_start', {}, ctx.value);
    await harness.emit('session_shutdown', {}, ctx.value);

    expect(ctx.setFooter).not.toHaveBeenCalled();
    expect(harness.exec).not.toHaveBeenCalled();
  });

  it('installs on session start, redraws on relevant events, and disposes on shutdown', async () => {
    const harness = extensionHarness();
    powerlineExtension(harness.pi);
    const ctx = extensionContext('tui');

    await harness.emit('session_start', {}, ctx.value);
    expect(ctx.setFooter).toHaveBeenCalledTimes(1);
    const factory = ctx.setFooter.mock.calls[0]![0] as (tui: TUI, theme: unknown, data: FooterDataLike) => Component & { dispose(): void };
    const requestRender = vi.fn();
    let branchChange: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const footerData: FooterDataLike = {
      getGitBranch: () => 'main',
      getExtensionStatuses: () => new Map(),
      getAvailableProviderCount: () => 1,
      onBranchChange: (callback) => {
        branchChange = callback;
        return unsubscribe;
      },
    };
    const footer = factory({ requestRender } as unknown as TUI, {}, footerData);
    await settle();
    const initialRenders = requestRender.mock.calls.length;

    for (const event of [
      'agent_start', 'agent_end', 'turn_end', 'tool_execution_end',
      'session_compact', 'session_tree', 'model_select', 'thinking_level_select',
    ]) {
      await harness.emit(event, {}, ctx.value);
    }
    branchChange?.();
    expect(requestRender.mock.calls.length).toBeGreaterThan(initialRenders + 8);

    await harness.emit('session_shutdown', {}, ctx.value);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(ctx.setFooter).toHaveBeenLastCalledWith(undefined);
    const afterShutdown = requestRender.mock.calls.length;
    branchChange?.();
    await harness.emit('agent_start', {}, ctx.value);
    await settle();
    expect(requestRender).toHaveBeenCalledTimes(afterShutdown);

    footer.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('registers lifecycle handlers and all namespaced flags at initialization', () => {
    const harness = extensionHarness();
    powerlineExtension(harness.pi);
    expect([...harness.handlers.keys()]).toEqual(expect.arrayContaining([
      'session_start', 'session_shutdown', 'agent_start', 'agent_end', 'turn_end',
      'tool_execution_end', 'session_compact', 'session_tree', 'model_select', 'thinking_level_select',
    ]));
    expect([...harness.flags.keys()]).toHaveLength(8);
    expect([...harness.flags.keys()].every((flag) => flag.startsWith('felan-powerline-'))).toBe(true);
  });
});

function extensionHarness() {
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
  const flags = new Map<string, { default?: boolean | string }>();
  const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', code: 128, killed: false });
  const pi = {
    on: (event: string, handler: (...args: any[]) => unknown) => {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
    registerFlag: (name: string, options: { default?: boolean | string }) => flags.set(name, options),
    getFlag: (name: string) => flags.get(name)?.default,
    exec,
    runtime: {},
  } as unknown as FelanExtensionAPI;
  return {
    pi,
    handlers,
    flags,
    exec,
    emit: async (event: string, ...args: unknown[]) => {
      for (const handler of handlers.get(event) ?? []) await handler(...args);
    },
  };
}

function extensionContext(mode: ExtensionContext['mode']) {
  const setFooter = vi.fn();
  const value = {
    mode,
    hasUI: mode === 'tui' || mode === 'rpc',
    cwd: '/workspace',
    ui: { setFooter },
    model: undefined,
    thinkingLevel: 'off',
    getContextUsage: () => undefined,
    sessionManager: { getEntries: () => [] },
  } as unknown as ExtensionContext;
  return { value, setFooter };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
