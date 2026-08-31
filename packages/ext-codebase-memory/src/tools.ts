import type { FelanExtensionAPI, ToolDefinition } from '@felan-ai/agent-core';
import { Type } from 'typebox';
import type { CbmClient } from './client.js';
import type { ProjectService, SymbolService } from './services.js';

const MaxSymbolLines = Type.Optional(Type.Integer({ minimum: 1, maximum: 220, default: 220 }));
const ProxyCommand = Type.Union([
  Type.Literal('index_repository'),
  Type.Literal('search_graph'),
  Type.Literal('query_graph'),
  Type.Literal('trace_path'),
  Type.Literal('get_graph_schema'),
  Type.Literal('get_architecture'),
  Type.Literal('index_status'),
  Type.Literal('check_index_coverage'),
  Type.Literal('detect_changes'),
]);
const PROXY_COMMANDS: ReadonlySet<string> = new Set(ProxyCommand.anyOf.map((entry) => entry.const));

export function registerTools(
  pi: FelanExtensionAPI,
  client: CbmClient,
  projects: ProjectService,
  symbols: SymbolService,
): void {
  const tools: ToolDefinition[] = [
    {
      name: 'codebase_memory',
      label: 'codebase_memory',
      description: 'Proxy a Codebase Memory structural query or explicitly refresh the current repository with command index_repository.',
      promptSnippet: 'Structural code query or explicit repository index refresh',
      parameters: Type.Object({
        command: ProxyCommand,
        arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      }, { additionalProperties: false }),
      execute: async (_id, params, signal) => {
        const input = params as { command: string; arguments?: Record<string, unknown> };
        if (!PROXY_COMMANDS.has(input.command)) {
          throw new Error(`Unsupported Codebase Memory command: ${input.command}`);
        }
        const args = input.arguments ?? {};
        const data = input.command === 'index_repository'
          ? await projects.index(signal)
          : (await client.call(input.command, {
            ...args,
            project: await projects.project(signal),
          }, signal === undefined ? {} : { signal })).data;
        return toolResult(data);
      },
    },
    {
      name: 'read_symbol',
      label: 'read_symbol',
      description: 'Resolve and read one function, method, class, type, route, or other named symbol.',
      promptSnippet: 'Resolve and read a named code symbol',
      parameters: Type.Object({
        name: Type.Optional(Type.String()),
        qualified_name: Type.Optional(Type.String()),
        file_path: Type.Optional(Type.String()),
        max_symbol_lines: MaxSymbolLines,
      }, { additionalProperties: false }),
      execute: async (_id, params, signal) => toolResult(await symbols.read(params as Record<string, unknown>, signal)),
    },
    {
      name: 'search_and_read_symbols',
      label: 'search_and_read_symbols',
      description: 'Find likely symbols and return focused source for the best matches.',
      promptSnippet: 'Search for symbols and read the best matches',
      parameters: Type.Object({
        query: Type.String(),
        file_pattern: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
        read_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12, default: 6 })),
        max_symbol_lines: MaxSymbolLines,
      }, { additionalProperties: false }),
      execute: async (_id, params, signal) => toolResult(await symbols.searchAndRead(params as Record<string, unknown>, signal)),
    },
    {
      name: 'search_code',
      label: 'search_code',
      description: 'Search indexed code for literal or regular-expression text with graph-aware context.',
      promptSnippet: 'Search indexed source text',
      parameters: Type.Object({
        pattern: Type.String(),
        file_pattern: Type.Optional(Type.String()),
        path_filter: Type.Optional(Type.String()),
        regex: Type.Optional(Type.Boolean()),
        context: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, default: 2 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
        max_symbol_lines: MaxSymbolLines,
      }, { additionalProperties: false }),
      execute: async (_id, params, signal) => {
        const input = params as Record<string, unknown>;
        const project = await projects.project(signal);
        return toolResult((await client.call('search_code', { ...input, project }, signal === undefined ? {} : { signal })).data);
      },
    },
  ];
  for (const tool of tools) pi.registerTool(tool);
}

function toolResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
    details: { data },
  };
}
