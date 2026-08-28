import { Type } from 'typebox';
import type { SymbolService } from '../domain/symbols.js';

export function createReadSymbolTool(symbols: SymbolService, assertEnabled: () => void = () => {}) {
  return {
    name: 'read_symbol',
    label: 'Read Symbol',
    description: 'Resolve a symbol and return source only when the match is unambiguous.',
    promptSnippet: 'read_symbol(name, file_path?, qualified_name?): read one unambiguous indexed symbol',
    parameters: Type.Object({
      name: Type.String(),
      project: Type.Optional(Type.String()),
      qualified_name: Type.Optional(Type.String()),
      file_path: Type.Optional(Type.String()),
      neighbors: Type.Optional(Type.Union([Type.Literal('none'), Type.Literal('callers'), Type.Literal('callees'), Type.Literal('both')])),
    }),
    execute: async (_id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, _update: unknown, ctx: { cwd: string }) => {
      assertEnabled();
      return await symbols.read(params, { cwd: ctx.cwd, signal });
    },
  };
}
