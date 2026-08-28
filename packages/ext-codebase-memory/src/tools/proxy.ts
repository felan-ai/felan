import { Type } from 'typebox';
import type { ToolTextResult } from '../cbm/result.js';
import type { CbmClient } from '../cbm/client.js';
import type { OutputService } from '../domain/output.js';
import type { ProjectService } from '../domain/project.js';

export function createProxyTool(cbm: CbmClient, projects: ProjectService, output: OutputService, assertEnabled: () => void = () => {}) {
  return {
    name: 'codebase_memory',
    label: 'Codebase Memory',
    description: 'Call a Codebase Memory command. Use index_repository to explicitly refresh after significant edits.',
    promptSnippet: 'codebase_memory(command, args?): call graph, architecture, trace, index-status, or refresh commands',
    parameters: Type.Object({
      command: Type.String({ description: 'Upstream command, for example search_graph, trace_path, index_status, or index_repository.' }),
      args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    execute: async (_id: string, params: { command: string; args?: Record<string, unknown> }, signal: AbortSignal | undefined, _update: unknown, ctx: { cwd: string }): Promise<ToolTextResult> => {
      assertEnabled();
      if (params.command === 'index_repository') {
        const result = await projects.indexCurrentRepo(ctx.cwd, signal);
        return output.result('Codebase Memory refresh', result);
      }
      const result = await cbm.callTool(params.command, params.args ?? {}, { signal });
      return output.result(`Codebase Memory: ${params.command}`, result.data);
    },
  };
}
