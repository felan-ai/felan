import { Type } from 'typebox';
import type { SymbolService } from '../domain/symbols.js';

export function createSearchAndReadSymbolsTool(symbols: SymbolService, assertEnabled: () => void = () => {}) {
  return {
    name: 'search_and_read_symbols',
    label: 'Search and Read Symbols',
    description: 'Find likely indexed symbols and return their source in one call.',
    promptSnippet: 'search_and_read_symbols(query/name_pattern, limit?): discover and read likely symbols',
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      name_pattern: Type.Optional(Type.String()),
      project: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 5 })),
    }),
    execute: async (_id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, _update: unknown, ctx: { cwd: string }) => {
      assertEnabled();
      return await symbols.searchAndRead(params, { cwd: ctx.cwd, signal });
    },
  };
}
