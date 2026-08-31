import type { AgentRuntime } from '@felan-ai/agent-core';
import { validateAutoIndexPath } from './auto-index-paths.js';
import { CacheManager, type CodebaseMemoryTelemetry } from './cache.js';
import { CbmClient, INDEX_TIMEOUT_MS } from './client.js';

const activeIndexes = new WeakMap<CbmClient, Map<string, Promise<IndexResult>>>();
const cacheAccounts = new Map<string, Promise<void>>();

export type IndexResult =
  | { status: 'indexed'; data: unknown }
  | { status: 'skipped'; reason: string };

export class ProjectService {
  readonly #cache: CacheManager;
  #project: string | undefined;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly client: CbmClient,
    maxCacheBytes: number | undefined,
    private readonly telemetry: CodebaseMemoryTelemetry,
  ) {
    this.#cache = new CacheManager(runtime, maxCacheBytes, telemetry, async (project) => {
      await client.call('delete_project', { project }).catch(() => {});
    });
  }

  async gitRoot(signal?: AbortSignal, timeout = 10_000): Promise<string | undefined> {
    const result = await this.runtime.exec('git', ['rev-parse', '--show-toplevel'], {
      cwd: this.runtime.cwd,
      maxOutputBytes: 64 * 1024,
      ...(signal === undefined ? {} : { signal }),
      timeout,
    });
    if (result.code !== 0 || result.killed) return undefined;
    return result.stdout.trim() || undefined;
  }

  async index(signal?: AbortSignal, repoPath?: string): Promise<IndexResult> {
    const root = repoPath ?? await this.gitRoot(signal);
    if (!root) {
      return { status: 'skipped', reason: 'no git repository detected at current directory' };
    }
    if (repoPath === undefined) {
      const validation = validateAutoIndexPath(root);
      if (!validation.ok) return { status: 'skipped', reason: validation.reason };
    }
    let clientIndexes = activeIndexes.get(this.client);
    if (!clientIndexes) {
      clientIndexes = new Map();
      activeIndexes.set(this.client, clientIndexes);
    }
    const existing = clientIndexes.get(root);
    if (existing) return existing;
    const request = this.client.call('index_repository', { repo_path: root, mode: 'full' }, {
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: INDEX_TIMEOUT_MS,
    }).then(async ({ data }): Promise<IndexResult> => {
      const record = asRecord(data);
      const project = typeof record.project === 'string' ? record.project : projectName(root);
      this.#project = project;
      await this.#cache.record(project, 0);
      void this.#accountCache();
      return { status: 'indexed', data };
    }).finally(() => {
      if (clientIndexes.get(root) === request) clientIndexes.delete(root);
    });
    clientIndexes.set(root, request);
    return request;
  }

  async #accountCache(): Promise<void> {
    const key = this.client.cacheRoot;
    const existing = cacheAccounts.get(key);
    if (existing) return existing;
    const account = this.#accountCacheOnce().finally(() => {
      if (cacheAccounts.get(key) === account) cacheAccounts.delete(key);
    });
    cacheAccounts.set(key, account);
    return account;
  }

  async #accountCacheOnce(): Promise<void> {
    try {
      const listed = await this.client.call('list_projects', {});
      const projects = arrayProperty(listed.data, 'projects');
      const bytes = projects.reduce<number>((sum, project) => {
        const bytes = asRecord(project).size_bytes;
        return typeof bytes === 'number' && Number.isFinite(bytes) ? sum + bytes : sum;
      }, 0);
      this.telemetry('cache_size', { bytes, maxBytes: this.#cache.maxBytes, projects: projects.length });
    } catch {
      return;
    }
  }


  async project(signal?: AbortSignal, timeoutMs?: number): Promise<string> {
    if (this.#project) return this.#project;
    const root = (await this.gitRoot(signal, timeoutMs)) ?? this.runtime.cwd;
    const listed = await this.client.call('list_projects', {}, {
      ...(signal === undefined ? {} : { signal }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    const projects = Array.isArray(asRecord(listed.data).projects) ? asRecord(listed.data).projects as unknown[] : [];
    const match = projects.map(asRecord).find((candidate) => candidate.root_path === root);
    this.#project = typeof match?.name === 'string' ? match.name : projectName(root);
    return this.#project;
  }
}

export class SymbolService {
  constructor(private readonly client: CbmClient, private readonly projects: ProjectService) {}

  async read(params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const project = await this.projects.project(signal);
    const search = await this.client.call('search_graph', {
      project,
      ...(params.qualified_name === undefined
        ? { query: params.name }
        : { qn_pattern: params.qualified_name }),
      format: 'json',
      limit: 10,
    }, signal === undefined ? {} : { signal });
    const candidates = searchCandidates(search.data);
    const matches = candidates.filter((item) => {
      const candidate = asRecord(item);
      const qualifiedName = typeof candidate.qualified_name === 'string' ? candidate.qualified_name : '';
      const requestedName = typeof params.name === 'string' ? params.name : undefined;
      return (!requestedName
          || candidate.name === requestedName
          || qualifiedName.split('.').at(-1) === requestedName)
        && (!params.qualified_name || qualifiedName === params.qualified_name)
        && (!params.file_path || String(candidate.file ?? candidate.file_path ?? '').includes(String(params.file_path)));
    });
    if (matches.length > 1) {
      return {
        project,
        candidates: matches,
        error: 'Symbol lookup is ambiguous; retry with qualified_name or file_path.',
      };
    }
    const selected = matches[0];
    const qualifiedName = asRecord(selected).qualified_name;
    if (typeof qualifiedName !== 'string') return { project, candidates, error: 'No matching symbol found' };
    const snippet = await this.client.call('get_code_snippet', { project, qualified_name: qualifiedName }, signal === undefined ? {} : { signal });
    return { project, symbol: selected, snippet: boundSnippet(snippet.data, params.max_symbol_lines) };
  }

  async searchAndRead(params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const project = await this.projects.project(signal);
    const search = await this.client.call('search_graph', {
      project,
      query: params.query,
      file_pattern: params.file_pattern,
      limit: params.limit ?? 20,
      format: 'json',
    }, signal === undefined ? {} : { signal });
    const candidates = searchCandidates(search.data);
    const readLimit = clampInt(params.read_limit, 1, 12, 6);
    const symbols = [];
    for (const candidate of candidates.slice(0, readLimit)) {
      const qualifiedName = asRecord(candidate).qualified_name;
      if (typeof qualifiedName !== 'string') continue;
      const snippet = await this.client.call('get_code_snippet', { project, qualified_name: qualifiedName }, signal === undefined ? {} : { signal });
      symbols.push({ symbol: candidate, snippet: boundSnippet(snippet.data, params.max_symbol_lines) });
    }
    return { project, candidates, symbols };
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayProperty(value: unknown, key: string): unknown[] {
  const candidate = asRecord(value)[key];
  return Array.isArray(candidate) ? candidate : [];
}

function searchCandidates(value: unknown): unknown[] {
  const results = arrayProperty(value, 'results');
  if (results.length > 0) return results;
  const record = asRecord(value);
  if (!Array.isArray(record.cols)) return [];
  const columns = record.cols.filter((column): column is string => typeof column === 'string');
  if (Array.isArray(record.groups)) return searchGroupedCandidates(record, columns);
  return arrayProperty(record, 'rows').filter(Array.isArray).map((row) => Object.fromEntries(
    columns.map((column, index) => [column === 'qn' ? 'qualified_name' : column, row[index]]),
  ));
}

function searchGroupedCandidates(record: Record<string, unknown>, columns: readonly string[]): unknown[] {
  return arrayProperty(record, 'groups').flatMap((group) => {
    const { qn_prefix: prefix, file } = asRecord(group);
    return arrayProperty(group, 'rows').filter(Array.isArray).map((row) => {
      const candidate = Object.fromEntries(columns.map((column, index) => [column, row[index]]));
      return { ...candidate, file, qualified_name: `${prefix}.${candidate.name}` };
    });
  });
}

function projectName(path: string): string {
  return path.replaceAll('\\', '/').split('/').filter(Boolean).at(-1)?.replace(/[^A-Za-z0-9._-]/gu, '-') || 'project';
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function boundSnippet(value: unknown, requestedLines: unknown): unknown {
  const maxLines = clampInt(requestedLines, 1, 220, 220);
  if (typeof value === 'string') return boundText(value, maxLines);
  const record = asRecord(value);
  for (const field of ['code', 'source', 'snippet'] as const) {
    if (typeof record[field] !== 'string') continue;
    const bounded = boundText(record[field], maxLines);
    if (typeof bounded === 'string') return value;
    return { ...record, [field]: bounded.text, truncated: true, original_lines: bounded.originalLines };
  }
  return value;
}

function boundText(value: string, maxLines: number): string | { text: string; originalLines: number } {
  const lines = value.split(/\r?\n/u);
  if (lines.length <= maxLines) return value;
  return { text: lines.slice(0, maxLines).join('\n'), originalLines: lines.length };
}
