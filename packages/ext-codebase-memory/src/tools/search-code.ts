import { Type } from 'typebox';
import type { QueryService } from '../domain/query.js';

export function createSearchCodeTool(query: QueryService, assertEnabled: () => void = () => {}) {
  return {
    name: 'search_code',
    label: 'Search Indexed Code',
    description: 'Search exact text or regular expressions across indexed source code.',
    promptSnippet: 'search_code(pattern, file_pattern?, path_filter?): search indexed source text',
    parameters: Type.Object({
      pattern: Type.String(),
      project: Type.Optional(Type.String()),
      file_pattern: Type.Optional(Type.String()),
      path_filter: Type.Optional(Type.String()),
      mode: Type.Optional(Type.Union([Type.Literal('compact'), Type.Literal('full'), Type.Literal('files')])),
      context: Type.Optional(Type.Integer({ minimum: 0 })),
      regex: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 10 })),
    }),
    execute: async (_id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, _update: unknown, ctx: { cwd: string }) => {
      assertEnabled();
      return await query.execute('Indexed code search', 'search_code', params, { cwd: ctx.cwd, signal });
    },
  };
}
