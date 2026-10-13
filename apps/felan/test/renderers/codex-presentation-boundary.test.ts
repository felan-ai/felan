import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { loadFelanExtensions, type AgentRuntime, type ExtensionAPI, type ExtensionContext, type FelanExtensionAPI, type Model, type Api } from '@felan-ai/agent-core';
import rootExtension, { createCodexTools } from '../../../../packages/ext-codex/src/index.js';
import runtimeExtension, { createCodexExecutionTools } from '../../../../packages/ext-codex/src/runtime.js';
import { createCodexToolRenderers } from '../../src/tui/renderers/codex.js';

it('keeps execution definitions renderer-free and looks up patch rendering in the client', () => {
  const tool = createCodexExecutionTools({} as AgentRuntime)[0]!;
  expect(createCodexTools).toBe(createCodexExecutionTools);
  expect(rootExtension).toBe(runtimeExtension);
  expect(tool.renderCall).toBeUndefined(); expect(tool.renderResult).toBeUndefined();
  const renderer = createCodexToolRenderers().apply_patch.renderCall!;
  const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
  for (const [context, label] of [[{ isPartial: false, isError: false }, 'Patched'], [{ isPartial: true, isError: false }, 'Patching'], [{ isPartial: false, isError: true }, 'Patch failed']] as const) {
    expect(renderer({}, theme as never, context as never).render(80).join('')).toContain(label);
  }
});

it.each([['root', rootExtension]] as const)('preserves configured generic loading, attribution and exact model activation through %s', async (_entry, entry) => {
  const runtime = { cwd: '/work/repo' } as AgentRuntime;
  const importer = vi.fn(async () => ({ default: entry }));
  const loaded = await loadFelanExtensions(['@felan-ai/ext-codex'], importer, runtime, '/agent', [
    { extensionId: 'codex', source: 'test', values: { priority: 'fast', verbosity: 'high' } },
  ]);
  expect(importer).toHaveBeenCalledExactlyOnceWith('@felan-ai/ext-codex');
  const extension = loaded[0];
  if (!extension || typeof extension === 'function') throw new Error('Expected a named extension');
  expect(extension.name).toBe('@felan-ai/ext-codex');
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  const ordinary = ['read', 'bash', 'edit', 'write', 'custom_tool'];
  let active = [...ordinary];
  await extension.factory({
    registerTool: vi.fn(),
    on: (name: string, handler: (event: any, ctx: ExtensionContext) => unknown) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
    getThinkingLevel: () => 'high',
  } as unknown as ExtensionAPI);
  for (const [provider, id, eligible] of [
    ['openai', 'gpt-5.4', true], ['openai-codex', 'GPT-5.4', true],
    ['OpenAI', 'gpt-5.4', false], ['openai-codex-proxy', 'gpt-5.4', false],
    ['custom', 'gpt-5.4', false], ['openai', 'gpt4', false], ['openai', 'o3', false],
    ['openai-codex', 'gpt-6-astra', true], ['anthropic', 'claude-sonnet-4', false],
  ] as const) {
    const model = { provider, id, api: 'openai-responses' } as Model<Api>;
    for (const handler of handlers.get('model_select') ?? []) await handler({ model }, { model } as ExtensionContext);
    expect([...active].sort()).toEqual((eligible ? ['read', 'bash', 'custom_tool', 'apply_patch'] : ordinary).slice().sort());
  }
  const model = { provider: 'openai', id: 'gpt-5.4', api: 'openai-responses' } as Model<Api>;
  const [request] = await Promise.all((handlers.get('before_provider_request') ?? []).map(handler => handler({ payload: {} }, { model } as ExtensionContext)));
  expect(request).toMatchObject({ service_tier: 'priority', text: { verbosity: 'high' } });
  for (const handler of handlers.get('session_shutdown') ?? []) await handler({}, {} as ExtensionContext);
});

it('keeps every local execution module free of presenter imports', async () => {
  const pending = [new URL('../../../../packages/ext-codex/src/index.ts', import.meta.url)];
  const visited = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file.href)) continue;
    visited.add(file.href);
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])([^'"]+)\1/gu)) {
      const specifier = match[2]!;
      expect(specifier, file.pathname).not.toMatch(/^@earendil-works\/pi-tui(?:\/|$)/u);
      if (specifier.startsWith('.')) pending.push(new URL(specifier.replace(/\.js$/u, '.ts'), file));
    }
  }
  expect([...visited].some(path => path.endsWith('/runtime.ts'))).toBe(true);
  expect([...visited].some(path => path.endsWith('/tui.ts'))).toBe(false);
});
