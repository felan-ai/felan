import type { ExtensionContext, FelanExtensionAPI } from '@felan-ai/agent-core';
import type { Component, TUI } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import powerlineExtension, {
  createPowerlineExtension,
  type AdditionalSessionUsageHost,
} from '../src/index.js';
import type { FooterDataLike } from '../src/segments.js';
import type { SubscriptionUsageHost } from '../src/subscription.js';

afterEach(() => vi.useRealTimers());

const theme = {
  getFgAnsi: (color: string) => `\x1b[38;5;42m`,
  getBgAnsi: (color: string) => `\x1b[48;5;42m`,
};

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

  it('reads the active Pi theme when the footer renders', async () => {
    const harness = extensionHarness();
    powerlineExtension(harness.pi);
    const ctx = extensionContext('tui');
    await harness.emit('session_start', {}, ctx.value);
    const factory = ctx.setFooter.mock.calls[0]![0] as (tui: TUI, theme: unknown, data: FooterDataLike) => Component & { render(width: number): string[] };
    const footer = factory(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      {
        getGitBranch: () => null,
        getExtensionStatuses: () => new Map(),
        getAvailableProviderCount: () => 1,
        onBranchChange: () => vi.fn(),
      },
    );

    const firstTheme = { getFgAnsi: () => '\x1b[38;5;42m', getBgAnsi: () => '\x1b[48;5;42m' };
    const secondTheme = { getFgAnsi: () => '\x1b[38;5;99m', getBgAnsi: () => '\x1b[48;5;99m' };
    ctx.ui.theme = firstTheme as never;
    const first = footer.render(80).join('\n');
    ctx.ui.theme = secondTheme as never;
    const second = footer.render(80).join('\n');

    expect(first).toContain('\x1b[38;5;42m');
    expect(second).toContain('\x1b[38;5;99m');
    expect(second).not.toContain('\x1b[38;5;42m');
    await harness.emit('session_shutdown', {}, ctx.value);
  });

  it('renders injected rows after the configured status lines', async () => {
    const harness = extensionHarness();
    createPowerlineExtension(undefined, {
      footerRows: () => ['agent rail'],
    })(harness.pi);
    const ctx = extensionContext('tui');

    await harness.emit('session_start', {}, ctx.value);
    const factory = ctx.setFooter.mock.calls[0]![0] as (
      tui: TUI,
      theme: unknown,
      data: FooterDataLike,
    ) => Component & { dispose(): void };
    const footer = factory(
      { requestRender: vi.fn() } as unknown as TUI,
      theme,
      {
        getGitBranch: () => null,
        getExtensionStatuses: () => new Map(),
        getAvailableProviderCount: () => 1,
        onBranchChange: () => vi.fn(),
      },
    );

    const lines = footer.render(80);

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.at(-1)).toBe('agent rail');
    await harness.emit('session_shutdown', {}, ctx.value);
  });

  it('redraws for additional session usage and unsubscribes on shutdown', async () => {
    let usageChanged: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const usageHost: AdditionalSessionUsageHost = {
      getUsage: vi.fn(() => ({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 })),
      subscribe: vi.fn((listener) => {
        usageChanged = listener;
        return unsubscribe;
      }),
    };
    const harness = extensionHarness();
    createPowerlineExtension(undefined, { additionalSessionUsageHost: usageHost })(harness.pi);
    const ctx = extensionContext('tui');

    await harness.emit('session_start', {}, ctx.value);
    const factory = ctx.setFooter.mock.calls[0]![0] as (
      tui: TUI,
      theme: unknown,
      data: FooterDataLike,
    ) => Component & { dispose(): void };
    const requestRender = vi.fn();
    const footer = factory(
      { requestRender } as unknown as TUI,
      theme,
      {
        getGitBranch: () => null,
        getExtensionStatuses: () => new Map(),
        getAvailableProviderCount: () => 1,
        onBranchChange: () => vi.fn(),
      },
    );
    footer.render(80);

    expect(usageHost.subscribe).toHaveBeenCalledOnce();
    expect(usageHost.getUsage).toHaveBeenCalled();
    const beforeUsageChange = requestRender.mock.calls.length;
    usageChanged?.();
    expect(requestRender.mock.calls.length).toBeGreaterThan(beforeUsageChange);

    await harness.emit('session_shutdown', {}, ctx.value);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it.each(['rpc', 'json', 'print'] as const)(
    'does not subscribe to additional session usage in %s mode',
    async (mode) => {
      const usageHost: AdditionalSessionUsageHost = {
        getUsage: vi.fn(() => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 })),
        subscribe: vi.fn(() => vi.fn()),
      };
      const harness = extensionHarness();
      createPowerlineExtension(undefined, { additionalSessionUsageHost: usageHost })(harness.pi);
      const ctx = extensionContext(mode);

      await harness.emit('session_start', {}, ctx.value);
      await harness.emit('session_shutdown', {}, ctx.value);

      expect(usageHost.subscribe).not.toHaveBeenCalled();
      expect(usageHost.getUsage).not.toHaveBeenCalled();
    },
  );

  it('registers lifecycle handlers without Pi flags', () => {
    const harness = extensionHarness();
    powerlineExtension(harness.pi);
    expect([...harness.handlers.keys()]).toEqual(expect.arrayContaining([
      'session_start', 'session_shutdown', 'agent_start', 'agent_end', 'turn_end',
      'tool_execution_end', 'session_compact', 'session_tree', 'model_select', 'thinking_level_select',
    ]));
    expect([...harness.flags.keys()]).toHaveLength(0);
  });

  it('refreshes injected subscription usage for TUI sessions and model changes', async () => {
    vi.useFakeTimers();
    const usageHost: SubscriptionUsageHost = {
      fetchUsage: vi.fn().mockResolvedValue({
        ok: true,
        data: { rate_limit: { primary_window: { used_percent: 20 } } },
      }),
    };
    const harness = extensionHarness();
    createPowerlineExtension(usageHost)(harness.pi);
    const ctx = extensionContext('tui', { provider: 'openai-codex', id: 'gpt-5.6-sol' });

    await harness.emit('session_start', {}, ctx.value);
    await vi.advanceTimersByTimeAsync(0);
    expect(usageHost.fetchUsage).toHaveBeenCalledOnce();
    expect(usageHost.fetchUsage).toHaveBeenLastCalledWith(expect.objectContaining({
      provider: 'codex',
      modelProvider: 'openai-codex',
      signal: expect.any(AbortSignal),
    }));

    const selected = extensionContext('tui', { provider: 'anthropic', id: 'claude-opus-4-6' });
    await harness.emit('model_select', {}, selected.value);
    await vi.advanceTimersByTimeAsync(0);
    expect(usageHost.fetchUsage).toHaveBeenCalledTimes(2);
    expect(usageHost.fetchUsage).toHaveBeenLastCalledWith(expect.objectContaining({
      provider: 'anthropic',
      modelProvider: 'anthropic',
    }));

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(usageHost.fetchUsage).toHaveBeenCalledTimes(3);
    expect(usageHost.fetchUsage).toHaveBeenLastCalledWith(expect.objectContaining({
      provider: 'anthropic',
    }));

    await harness.emit('session_shutdown', {}, selected.value);
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
    exec,
    agentDir: '/agent',
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

function extensionContext(mode: ExtensionContext['mode'], model?: Record<string, unknown>) {
  const setFooter = vi.fn();
  const theme = {
    getFgAnsi: (color: string) => `\x1b[38;5;42m`,
    getBgAnsi: (color: string) => `\x1b[48;5;42m`,
  };
  const ui = { setFooter, theme };
  const value = {
    mode,
    hasUI: mode === 'tui' || mode === 'rpc',
    cwd: '/workspace',
    ui,
    model,
    thinkingLevel: 'off',
    getContextUsage: () => undefined,
    sessionManager: { getEntries: () => [] },
  } as unknown as ExtensionContext;
  return { value, setFooter, ui };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
