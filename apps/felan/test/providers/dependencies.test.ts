import { inspectClaudeCodeRuntime, installManagedClaudeAgentSdk, MANAGED_CLAUDE_AGENT_SDK_VERSION } from '@felan-ai/ext-claude-code';
import type { AgentRuntime, RuntimeDependenciesService } from '@felan-ai/agent-core';
import { expect, it, vi } from 'vitest';
import { setupDependencies } from '../../src/providers/dependencies.js';
import runtimeDependencies from '../../src/providers/runtime-dependencies.js';

vi.mock('@felan-ai/ext-claude-code', async importOriginal => ({
  ...await importOriginal<typeof import('@felan-ai/ext-claude-code')>(), inspectClaudeCodeRuntime: vi.fn(),
}));

it('exposes binary-backed setup dependencies without an OS utility installer', () => {
  expect(setupDependencies.map(({ id }) => id)).toEqual([
    'background-bash', 'agent-browser', 'claude-code', 'codebase-memory', 'markitdown', 'rtk',
  ]);
  expect(setupDependencies.find(({ id }) => id === 'background-bash')).toMatchObject({
    extension: 'backgroundBash',
  });
  expect(setupDependencies.find(({ id }) => id === 'background-bash')?.install).toBeUndefined();
  expect(setupDependencies.find(({ id }) => id === 'codebase-memory')).toMatchObject({
    revision: 2, description: expect.stringContaining('Codebase Memory 0.11.0'),
  });
  expect(setupDependencies.every(dependency => !('skipDisables' in dependency))).toBe(true);
});

it('offers the managed Claude Agent SDK only through explicit setup', () => {
  const dependency = setupDependencies.find(({ id }) => id === 'claude-code');
  expect(dependency).toMatchObject({
    extension: 'claudeCode', revision: 1, label: 'Claude Code', requiredVersion: MANAGED_CLAUDE_AGENT_SDK_VERSION,
    install: installManagedClaudeAgentSdk,
  });
  for (const detail of [MANAGED_CLAUDE_AGENT_SDK_VERSION, '~330 MB', 'MCP peers', 'Felan agent storage', "Anthropic's terms", 'Claude Code login']) {
    expect(dependency?.description).toContain(detail);
  }
});

it('reports the installed Claude Agent SDK version separately from the required version', async () => {
  const dependency = setupDependencies.find(({ id }) => id === 'claude-code')!;
  const runtime = {} as AgentRuntime;
  const reason = `Claude Agent SDK 0.3.293 is installed; ${MANAGED_CLAUDE_AGENT_SDK_VERSION} is required.`;
  vi.mocked(inspectClaudeCodeRuntime).mockResolvedValueOnce({ available: false, installedVersion: '0.3.293', reason });
  await expect(dependency.check(runtime)).resolves.toEqual({ available: false, version: '0.3.293', reason });
  vi.mocked(inspectClaudeCodeRuntime).mockResolvedValueOnce({ available: false, reason: 'Not installed.' });
  await expect(dependency.check(runtime)).resolves.toEqual({ available: false, reason: 'Not installed.' });
  const available = { available: true as const, version: MANAGED_CLAUDE_AGENT_SDK_VERSION, entryPath: '/fixture/sdk.mjs' };
  vi.mocked(inspectClaudeCodeRuntime).mockResolvedValueOnce(available);
  await expect(dependency.check(runtime)).resolves.toBe(available);
});

it('routes Claude Code installs through the host dependency policy and stops at disposal', async () => {
  const install = vi.fn(async () => ({ status: 'installed' as const }));
  const context = {
    signal: new AbortController().signal,
    runtimeDependencies: { install },
  } as unknown as Parameters<typeof runtimeDependencies.create>[0];
  const instance = await runtimeDependencies.create(context);
  const service = instance.implementations[0]!.value as RuntimeDependenciesService;
  expect(install).not.toHaveBeenCalled();

  const signal = new AbortController().signal;
  await expect(service.install({ id: 'claude-code' }, { signal })).resolves.toEqual({ status: 'installed' });
  expect(install).toHaveBeenCalledExactlyOnceWith({ id: 'claude-code' }, { signal: expect.any(AbortSignal) });
  await expect(service.install({ id: 'unknown' })).resolves.toMatchObject({ status: 'unavailable' });
  await instance.dispose();
  await expect(service.install({ id: 'claude-code' })).resolves.toMatchObject({ status: 'unavailable' });
  expect(install).toHaveBeenCalledTimes(1);
});
