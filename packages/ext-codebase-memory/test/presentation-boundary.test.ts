import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import type { FelanExtensionAPI, ToolDefinition } from '@felan-ai/agent-core';
import { registerExecutionTools } from '../src/execution-tools.js';
import { registerTools } from '../src/tools.js';
import { createCodebaseMemoryToolPresentation } from '../src/tui.js';

it('preserves tool contracts in every mode without attaching renderers to execution tools', () => {
  for (const mode of ['curated', 'proxy', 'direct'] as const) {
    const legacy: ToolDefinition[] = []; const execution: ToolDefinition[] = [];
    registerTools({ registerTool: (value: ToolDefinition) => legacy.push(value) } as unknown as FelanExtensionAPI, {} as never, {} as never, {} as never, mode);
    registerExecutionTools({ registerTool: (value: ToolDefinition) => execution.push(value) } as unknown as FelanExtensionAPI, {} as never, {} as never, {} as never, mode);
    expect(execution.length).toBeGreaterThan(0); expect(execution.length).toBe(legacy.length);
    for (const [index, tool] of execution.entries()) {
      expect(tool.name).toBe(legacy[index]!.name); expect(tool.parameters).toEqual(legacy[index]!.parameters);
      expect(tool.description).toBe(legacy[index]!.description); expect(tool.renderCall).toBeUndefined();
      expect(legacy[index]!.renderCall).toBeTypeOf('function');
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

it('keeps the renderer independent of index clients and the runtime independent of TUI', async () => {
  const runtime = await readFile(new URL('../src/runtime.ts', import.meta.url), 'utf8');
  const tools = await readFile(new URL('../src/execution-tools.ts', import.meta.url), 'utf8');
  const renderer = await readFile(new URL('../src/tui.ts', import.meta.url), 'utf8');
  expect(runtime + tools).not.toContain('@earendil-works/pi-tui');
  expect(runtime + tools).not.toContain("from './tui.js'");
  expect(renderer).not.toMatch(/import (?!type)[^;]*from ['"]\.\/(?:client|services|installer|runtime)/u);
});
