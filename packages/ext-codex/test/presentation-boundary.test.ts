import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import type { AgentRuntime } from '@felan-ai/agent-core';
import { createCodexTools } from '../src/index.js';
import { createCodexExecutionTools } from '../src/runtime.js';
import { createCodexToolRenderers } from '../src/tui.js';

it('preserves legacy tool metadata and patch renderers while keeping execution definitions renderer-free', () => {
  const runtime = {} as AgentRuntime;
  const legacy = createCodexTools(runtime)[0]!; const execution = createCodexExecutionTools(runtime)[0]!;
  for (const key of ['name', 'label', 'description', 'promptSnippet', 'promptGuidelines', 'parameters', 'executionMode'] as const) {
    expect(execution[key]).toEqual(legacy[key]);
  }
  expect(execution.renderCall).toBeUndefined(); expect(execution.renderResult).toBeUndefined();
  for (const value of [{ input: 'patch' }, { patchText: 'patch' }, { patch: 'patch' }, {}]) {
    expect(execution.prepareArguments?.(value)).toEqual(legacy.prepareArguments?.(value));
  }
  const renderer = createCodexToolRenderers().apply_patch!.renderCall!;
  const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
  for (const context of [{ isPartial: false, isError: false }, { isPartial: true, isError: false }, { isPartial: false, isError: true }]) {
    expect(renderer({}, theme as never, context as never).render(80))
      .toEqual(legacy.renderCall!({}, theme as never, context as never).render(80));
  }
});

it('keeps every local execution module free of presenter imports', async () => {
  for (const name of ['runtime', 'execution-tools', 'compaction', 'model-policy', 'reasoning-updates', 'request-options', 'config', 'patch', 'transport', 'service-tier']) {
    const text = await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
    expect(text).not.toMatch(/from ['"](?:@earendil-works\/pi-tui|\.\/tui\.js|\.\/tools\.js)['"]/u);
  }
});
