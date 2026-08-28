import type { CbmClient } from '../cbm/client.js';
import type { ToolTextResult } from '../cbm/result.js';
import type { OutputService } from './output.js';
import type { ProjectService, ToolExecutionContext } from './project.js';

export class SymbolService {
  constructor(private readonly cbm: CbmClient, private readonly projects: ProjectService, private readonly output: OutputService) {}

  async read(params: Readonly<Record<string, unknown>>, ctx: ToolExecutionContext): Promise<ToolTextResult> {
    const project = typeof params.project === 'string' ? params.project : await this.projects.inferProject(ctx.cwd, ctx.signal);
    const name = String(params.name ?? params.qualified_name ?? '');
    const search = await this.cbm.callTool('search_graph', {
      project,
      name_pattern: `^${escapeRegex(name)}$`,
      limit: 20,
      fields: ['signature'],
      format: 'json',
    }, { signal: ctx.signal });
    const candidates = candidatesFrom(search.data).filter((candidate) => matches(candidate, params));
    if (candidates.length !== 1) return this.output.result('Symbol resolution', {
      error: candidates.length === 0 ? 'No symbol matched.' : 'Symbol is ambiguous; add file_path or qualified_name.',
      candidates,
    });
    const qualifiedName = String(candidates[0]!.qualified_name ?? candidates[0]!.qn ?? name);
    const snippet = await this.cbm.callTool('get_code_snippet', {
      project,
      qualified_name: qualifiedName,
      include_neighbors: params.neighbors !== undefined && params.neighbors !== 'none',
    }, { signal: ctx.signal });
    return this.output.result(`Symbol: ${qualifiedName}`, snippet.data);
  }

  async searchAndRead(params: Readonly<Record<string, unknown>>, ctx: ToolExecutionContext): Promise<ToolTextResult> {
    const project = typeof params.project === 'string' ? params.project : await this.projects.inferProject(ctx.cwd, ctx.signal);
    const limit = Math.max(1, Math.min(Number(params.limit ?? 5), 20));
    const searchArgs = typeof params.query === 'string'
      ? { project, query: params.query, limit, format: 'json' }
      : { project, name_pattern: String(params.name_pattern ?? params.name ?? '.*'), limit, format: 'json' };
    const search = await this.cbm.callTool('search_graph', searchArgs, { signal: ctx.signal });
    const candidates = candidatesFrom(search.data).slice(0, limit);
    const snippets = await Promise.all(candidates.map(async (candidate) => {
      const qualifiedName = String(candidate.qualified_name ?? candidate.qn ?? '');
      const result = await this.cbm.callTool('get_code_snippet', { project, qualified_name: qualifiedName }, { signal: ctx.signal, allowError: true });
      return { qualified_name: qualifiedName, source: result.data };
    }));
    return this.output.result('Symbol search and source', { candidates, snippets });
  }
}

function candidatesFrom(data: unknown): Array<Record<string, unknown>> {
  if (typeof data !== 'object' || data === null) return [];
  const direct = Reflect.get(data, 'results');
  if (Array.isArray(direct)) return direct.filter(isRecord);
  const groups = Reflect.get(data, 'groups');
  if (!Array.isArray(groups)) return [];
  const cols = Reflect.get(data, 'cols');
  const columnNames = Array.isArray(cols) && cols.every((column): column is string => typeof column === 'string') ? cols : [];
  return groups.flatMap((group) => candidatesFromGroup(group, columnNames));
}

function candidatesFromGroup(group: unknown, columnNames: readonly string[]): Array<Record<string, unknown>> {
  if (!isRecord(group) || !Array.isArray(group.rows)) return [];
  return group.rows.flatMap((row) => {
    const candidate = isRecord(row) ? row : candidateFromRow(row, columnNames);
    if (!candidate) return [];
    const name = typeof candidate.name === 'string' ? candidate.name : undefined;
    const prefix = typeof group.qn_prefix === 'string' ? group.qn_prefix : undefined;
    const qualifiedName = prefix && name
      ? `${prefix}.${name}`
      : typeof candidate.qualified_name === 'string'
        ? candidate.qualified_name
        : typeof candidate.qn === 'string' ? candidate.qn : name;
    const filePath = typeof group.file === 'string'
      ? group.file
      : typeof candidate.file_path === 'string'
        ? candidate.file_path
        : typeof candidate.file === 'string' ? candidate.file : undefined;
    return [{
      ...candidate,
      ...(qualifiedName ? { qualified_name: qualifiedName } : {}),
      ...(filePath ? { file_path: filePath } : {}),
      ...lineRangeFrom(candidate.lines),
    }];
  });
}

function candidateFromRow(row: unknown, columnNames: readonly string[]): Record<string, unknown> | undefined {
  if (!Array.isArray(row) || columnNames.length === 0) return undefined;
  return Object.fromEntries(columnNames.map((column, index) => [column, row[index]]));
}

function lineRangeFrom(lines: unknown): Readonly<Record<string, number>> {
  if (typeof lines === 'number' && Number.isInteger(lines) && lines >= 0) return { start_line: lines, end_line: lines };
  if (typeof lines !== 'string') return {};
  const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/u.exec(lines);
  if (!match) return {};
  const startLine = Number(match[1]);
  return { start_line: startLine, end_line: Number(match[2] ?? match[1]) };
}
function matches(candidate: Record<string, unknown>, params: Readonly<Record<string, unknown>>): boolean {
  if (typeof params.qualified_name === 'string' && candidate.qualified_name !== params.qualified_name && candidate.qn !== params.qualified_name) return false;
  if (typeof params.file_path === 'string' && !String(candidate.file_path ?? candidate.file ?? '').includes(params.file_path)) return false;
  return true;
}
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
