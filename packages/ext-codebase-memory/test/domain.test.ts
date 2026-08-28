import { describe, expect, it, vi } from 'vitest';
import { enforceCacheLimit, resolveCacheCap } from '../src/cache/lru.js';
import { validateAutoIndexPath } from '../src/domain/auto-index-paths.js';
import { OutputService } from '../src/domain/output.js';
import { ProjectService } from '../src/domain/project.js';
import { SymbolService } from '../src/domain/symbols.js';
import { CbmAugmentService } from '../src/extension/augment.js';
import { MemoryRuntime } from './test-runtime.js';

describe('safe project indexing', () => {
  it('allows only the cwd/git project and deduplicates concurrent startup indexes', async () => {
    expect(validateAutoIndexPath('/', '/workspace/repo', '/workspace/repo')).toMatchObject({ ok: false });
    expect(validateAutoIndexPath('/workspace', '/workspace/repo', '/workspace/repo')).toMatchObject({ ok: false });
    expect(validateAutoIndexPath('/workspace/repo', '/workspace/repo/src', '/workspace/repo')).toEqual({
      ok: true,
      path: '/workspace/repo',
    });
    expect(validateAutoIndexPath('/workspace/other', '/workspace/repo', '/workspace/repo')).toMatchObject({ ok: false });

    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const callTool = vi.fn(async (tool: string) => {
      if (tool === 'index_repository') {
        markStarted();
        await new Promise<void>((resolve) => { release = resolve; });
        return { ok: true, data: { project: 'repo' }, rawText: '', stderr: '' };
      }
      return { ok: true, data: { projects: [] }, rawText: '', stderr: '' };
    });
    const client = { findGitRoot: async () => '/workspace/repo', gitRoot: async () => '/workspace/repo', callTool } as never;
    const first = new ProjectService(client, '/workspace/repo', 1_200_000);
    const second = new ProjectService(client, '/workspace/repo', 1_200_000);
    const indexing = first.indexCurrentRepo('/workspace/repo');
    await started;
    await expect(second.indexCurrentRepo('/workspace/repo')).resolves.toMatchObject({ status: 'deduplicated' });
    release();
    await expect(indexing).resolves.toMatchObject({ status: 'indexed', project: 'repo' });
    expect(callTool.mock.calls.filter(([tool]) => tool === 'index_repository')).toHaveLength(1);
  });
});

describe('cache LRU', () => {
  it('uses environment defaults, measures without reading cache files, and evicts oldest projects', async () => {
    expect(resolveCacheCap('host', undefined)).toBe(2_000_000_000);
    expect(resolveCacheCap('daytona', undefined)).toBe(500_000_000);
    expect(resolveCacheCap('docker', 1234)).toBe(1234);
    let measurements = 0;
    const runtime = new MemoryRuntime(async (command) => {
      if (command !== 'du') throw new Error(`unexpected command: ${command}`);
      measurements += 1;
      return measurements === 1
        ? { stdout: '2\t/agent-storage/codebase-memory\n', stderr: '', code: 0, killed: false }
        : { stdout: '1\t/agent-storage/codebase-memory\n', stderr: '', code: 0, killed: false };
    }, 'daytona');
    runtime.files.set('codebase-memory/cache/a.db', new Uint8Array(800));
    runtime.files.set('codebase-memory/cache/b.db', new Uint8Array(500));
    const calls: unknown[] = [];
    const telemetry: unknown[] = [];
    const client = { callTool: async (...args: unknown[]) => { calls.push(args); return { ok: true }; } } as never;

    await expect(enforceCacheLimit(runtime, client, [
      { name: 'old', size_bytes: 800, last_accessed: '2025-01-01T00:00:00Z' },
      { name: 'new', size_bytes: 500, last_accessed: '2026-01-01T00:00:00Z' },
    ], 1_500, (event) => telemetry.push(event))).resolves.toMatchObject({ evicted: ['old'], sizeBytes: 1024 });
    expect(calls).toEqual([['delete_project', { project: 'old' }, { allowError: true }]]);
    expect(runtime.readCalls).toEqual([]);
    expect(runtime.execCalls.map((call) => call.command)).toEqual(['du', 'du']);
    expect(telemetry).toEqual([
      expect.objectContaining({ event: 'cache_size', sizeBytes: 2048 }),
      expect.objectContaining({ event: 'cache_eviction', project: 'old' }),
      expect.objectContaining({ event: 'cache_size', sizeBytes: 1024 }),
    ]);
  });

  it('does not evict when cache measurement fails', async () => {
    const runtime = new MemoryRuntime(async (command) => command === 'du'
      ? { stdout: '', stderr: 'du unavailable', code: 127, killed: false }
      : { stdout: '', stderr: '', code: 0, killed: false });
    const callTool = vi.fn();
    const telemetry: unknown[] = [];

    await expect(enforceCacheLimit(runtime, { callTool } as never, [
      { name: 'old', last_accessed: '2025-01-01T00:00:00Z' },
    ], 1, (event) => telemetry.push(event))).resolves.toMatchObject({ evicted: [], sizeBytes: undefined });

    expect(callTool).not.toHaveBeenCalled();
    expect(telemetry).toEqual([
      expect.objectContaining({ event: 'cache_size', measured: false }),
    ]);
  });

  it('refuses cache operations when agent storage is not the asserted root', async () => {
    const runtime = new MemoryRuntime(undefined, 'host', '/workspace', '/');
    await expect(enforceCacheLimit(runtime, {} as never, [], 10)).rejects.toThrow('storage root');
  });
});

describe('search result augmentation', () => {
  it.each([
    ['grep', { pattern: 'WidgetHandler' }],
    ['find', { pattern: '*WidgetHandler*' }],
    ['bash', { command: 'rg WidgetHandler src' }],
    ['exec_command', { cmd: 'rg WidgetHandler src' }],
  ])('augments %s results', async (toolName, input) => {
    const cbm = { callTool: vi.fn(async () => ({
      ok: true,
      data: { results: [{ qualified_name: 'app.WidgetHandler', file_path: 'src/widget.ts', start_line: 7 }] },
    })) } as never;
    const projects = { inferProject: async () => 'repo' } as never;
    const service = new CbmAugmentService(cbm, projects, 1_500);
    const outcome = await service.augmentResult({
      toolName,
      input,
      content: [{ type: 'text', text: 'raw search' }],
      isError: false,
    }, { cwd: '/workspace/repo' });
    expect(outcome).toMatchObject({ status: 'matched', token: 'WidgetHandler' });
    if (outcome.status === 'matched') expect(outcome.content[0]).toMatchObject({ text: expect.stringContaining('app.WidgetHandler') });
  });
});

describe('symbol workflows', () => {
  const groupedSearchResult = {
    cols: ['name', 'label', 'lines', 'in', 'out', 'signature'],
    groups: [{
      qn_prefix: 'src.portable-memory',
      file: 'src/portable-memory.ts',
      rows: [['WidgetHandler', 'Function', '1-3', 0, 0, '(value: string)']],
    }],
  };

  it('searches and reads symbols from grouped column-and-row results', async () => {
    const cbm = {
      callTool: vi.fn(async (tool: string) => tool === 'search_graph'
        ? { ok: true, data: groupedSearchResult }
        : { ok: true, data: 'export function WidgetHandler() {}' }),
    } as never;
    const symbols = new SymbolService(cbm, { inferProject: async () => 'repo' } as never, new OutputService(220));

    const result = await symbols.searchAndRead({ name_pattern: 'WidgetHandler' }, { cwd: '/workspace/repo' });

    expect(result.details.data).toEqual({
      candidates: [{
        name: 'WidgetHandler',
        label: 'Function',
        lines: '1-3',
        in: 0,
        out: 0,
        signature: '(value: string)',
        qualified_name: 'src.portable-memory.WidgetHandler',
        file_path: 'src/portable-memory.ts',
        start_line: 1,
        end_line: 3,
      }],
      snippets: [{
        qualified_name: 'src.portable-memory.WidgetHandler',
        source: 'export function WidgetHandler() {}',
      }],
    });
  });

  it('resolves a grouped symbol by its qualified name and file path', async () => {
    const cbm = {
      callTool: vi.fn(async (tool: string) => tool === 'search_graph'
        ? { ok: true, data: groupedSearchResult }
        : { ok: true, data: 'export function WidgetHandler() {}' }),
    } as never;
    const symbols = new SymbolService(cbm, { inferProject: async () => 'repo' } as never, new OutputService(220));

    const result = await symbols.read({
      name: 'WidgetHandler',
      qualified_name: 'src.portable-memory.WidgetHandler',
      file_path: 'src/portable-memory.ts',
    }, { cwd: '/workspace/repo' });

    expect(result.details.data).toBe('export function WidgetHandler() {}');
  });

  it('preserves direct object search results', async () => {
    const directCandidate = {
      name: 'WidgetHandler',
      qualified_name: 'src.WidgetHandler',
      file_path: 'src/widget.ts',
      start_line: 4,
      end_line: 6,
    };
    const cbm = {
      callTool: vi.fn(async (tool: string) => tool === 'search_graph'
        ? { ok: true, data: { results: [directCandidate] } }
        : { ok: true, data: 'export function WidgetHandler() {}' }),
    } as never;
    const symbols = new SymbolService(cbm, { inferProject: async () => 'repo' } as never, new OutputService(220));

    const result = await symbols.searchAndRead({ query: 'WidgetHandler' }, { cwd: '/workspace/repo' });

    expect(result.details.data).toEqual({
      candidates: [directCandidate],
      snippets: [{
        qualified_name: 'src.WidgetHandler',
        source: 'export function WidgetHandler() {}',
      }],
    });
  });
});
