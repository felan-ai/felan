import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import type { FelanExtensionAPI, ToolDefinition } from '@felan-ai/agent-core';
import { registerExecutionTools } from '../../../../packages/ext-codebase-memory/src/execution-tools.js';
import { createCodebaseMemoryToolPresentation } from '../../src/tui/renderers/codebase-memory.js';

it('preserves tool contracts in every mode without attaching renderers to execution tools', () => {
  for (const mode of ['curated', 'proxy', 'direct'] as const) {
    const legacy: ToolDefinition[] = []; const execution: ToolDefinition[] = [];
    registerExecutionTools({ registerTool: (value: ToolDefinition) => legacy.push(value) } as unknown as FelanExtensionAPI, {} as never, {} as never, {} as never, mode);
    registerExecutionTools({ registerTool: (value: ToolDefinition) => execution.push(value) } as unknown as FelanExtensionAPI, {} as never, {} as never, {} as never, mode);
    expect(execution.length).toBeGreaterThan(0); expect(execution.length).toBe(legacy.length);
    for (const [index, tool] of execution.entries()) {
      expect(tool.name).toBe(legacy[index]!.name); expect(tool.parameters).toEqual(legacy[index]!.parameters);
      expect(tool.description).toBe(legacy[index]!.description); expect(tool.renderCall).toBeUndefined();
      expect(createCodebaseMemoryToolPresentation(mode, tool.name).renderCall).toBeTypeOf('function');
    }
  }
});

it('retains curated and raw call labels and sanitizes untrusted details', () => {
  const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
  for (const [mode, name, args, expected] of [
    ['curated', 'codebase_memory', { command: 'query_graph', arguments: { query: 'needle' } }, 'codebase_memory query_graph · needle'],
    ['curated', 'read_symbol', { name: 'hello', file_path: 'src/a.ts' }, 'read_symbol hello · src/a.ts'],
    ['curated', 'search_and_read_symbols', { query: 'hello', file_pattern: '*.ts' }, 'search_and_read_symbols hello · *.ts'],
    ['curated', 'search_code', { pattern: 'needle', path_filter: 'src' }, 'search_code needle · src'],
    ['proxy', 'codebase_memory', { command: 'query_graph', arguments: { query: 'hidden' } }, 'codebase_memory query_graph'],
    ['direct', 'query_graph', { query: 'needle\u001b' }, 'query_graph needle'],
  ] as const) {
    const render = createCodebaseMemoryToolPresentation(mode, name).renderCall!;
    expect(render(args, theme as never, {} as never).render(200).map(line => line.trimEnd()).join('\n')).toBe(expected);
  }
});

it('keeps the public root and runtime independent of TUI and direct renderer I/O', async () => {
  const pending = [new URL('../../../../packages/ext-codebase-memory/src/index.ts', import.meta.url)];
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
  expect([...visited].some(path => path.endsWith('/tui.ts') || path.endsWith('/tools.ts'))).toBe(false);
  const renderer = await readFile(new URL('../../src/tui/renderers/codebase-memory.ts', import.meta.url), 'utf8');
  expect(renderer).not.toMatch(/import (?!type)[^;]*from ['"]\.\/(?:client|services|installer)/u);
});
