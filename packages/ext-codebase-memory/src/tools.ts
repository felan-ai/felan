import type { FelanExtensionAPI, Theme, ToolDefinition } from '@felan-ai/agent-core';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';
import type { CbmClient } from './client.js';
import { asRecord, type ProjectService, type SymbolService } from './services.js';

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
      renderCall(params, theme) {
        const input = params as { command: string; arguments?: Record<string, unknown> };
        const args = asRecord(input.arguments);
        return renderToolCall(
          theme,
          'codebase_memory',
          input.command,
          firstString(
            args.query,
            args.pattern,
            args.function_name,
            args.qualified_name,
            args.name,
            args.qn_pattern,
            args.name_pattern,
            args.file_pattern,
            args.path_filter,
          ),
        );
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
      renderCall(params, theme) {
        const input = params as Record<string, unknown>;
        return renderToolCall(theme, 'read_symbol', input.name ?? input.qualified_name, input.file_path);
      },
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
      renderCall(params, theme) {
        const input = params as Record<string, unknown>;
        return renderToolCall(theme, 'search_and_read_symbols', input.query, input.file_pattern);
      },
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
      renderCall(params, theme) {
        const input = params as Record<string, unknown>;
        return renderToolCall(theme, 'search_code', input.pattern, input.file_pattern ?? input.path_filter);
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

function renderToolCall(theme: Theme, label: string, ...values: unknown[]): Text {
  const detail = compactToolDetail(values);
  const title = theme.fg('toolTitle', theme.bold(label));
  return new Text(detail ? `${title} ${theme.fg('accent', detail)}` : title, 0, 0);
}

function compactToolDetail(values: readonly unknown[]): string {
  const normalized = values
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim())
    .filter((value) => value.length > 0)
    .join(' · ');
  const characters = [...normalized];
  return characters.length <= 120 ? normalized : `${characters.slice(0, 119).join('')}…`;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}
