import { describe, expect, it, vi } from 'vitest';
import { CbmClient, INDEX_TIMEOUT_MS, MAX_OUTPUT_BYTES } from '../src/client.js';
import { dispatchRawCommand } from '../src/raw-dispatch.js';
import { ProjectService } from '../src/services.js';
import { envelope, MemoryRuntime, result } from './test-runtime.js';

function fixture() {
  const runtime = new MemoryRuntime('host', true, async (command) => {
    if (command.includes('list_projects')) {
      return result(envelope({ projects: [{ name: 'fixture', root_path: '/work/repo' }] }));
    }
    if (command.includes('index_repository')) return result(envelope({ project: 'fixture', status: 'indexed' }));
    return result(envelope({ source: 'raw upstream source', metadata: { untouched: true } }));
  });
  const client = new CbmClient(runtime, { command: 'codebase-memory-mcp', version: '0.10.8', source: 'managed' });
  const projects = new ProjectService(runtime, client, undefined, vi.fn());
  return {
    runtime,
    call: (command: string, args: unknown = {}, signal?: AbortSignal) => dispatchRawCommand(client, projects, command, args, signal),
  };
}

describe('raw Codebase Memory dispatch', () => {
  it('injects the active project and preserves raw payloads, arguments and transport limits', async () => {
    const { runtime, call } = fixture();
    const signal = new AbortController().signal;
    const args = { qualified_name: 'fixture.answer' };
    expect(await call('get_code_snippet', args, signal)).toEqual({
      source: 'raw upstream source', metadata: { untouched: true },
    });
    expect(args).toEqual({ qualified_name: 'fixture.answer' });
    expect(runtime.shellCalls.at(-1)).toMatchObject({
      command: expect.stringContaining('"project":"fixture"'),
      options: { signal, maxOutputBytes: MAX_OUTPUT_BYTES, timeout: 60_000 },
    });
    expect(runtime.shellCalls.at(-1)?.command).toContain('"qualified_name":"fixture.answer"');
  });

  it('rejects another project rather than silently querying it', async () => {
    const { runtime, call } = fixture();
    await expect(call('search_graph', { project: 'other', query: 'answer' })).rejects.toThrow('active project');
    expect(runtime.shellCalls.some(({ command }) => command.includes('search_graph'))).toBe(false);
    await expect(call('search_graph', { project: 'fixture', query: 'answer' })).resolves.toBeDefined();
  });

  it('allows global listing without project resolution or indexing even in a rejected root', async () => {
    const { runtime, call } = fixture();
    runtime.gitTopLevel = '/Users/alice';
    await call('list_projects', { limit: 10, offset: 0 });
    expect(runtime.execCalls).toHaveLength(0);
    expect(runtime.shellCalls).toHaveLength(1);
    expect(runtime.shellCalls[0]?.command).toContain('"limit":10');
    expect(runtime.shellCalls[0]?.command).not.toContain('"project"');
  });

  it('retains automatic path rejection and explicit indexing with cache bookkeeping', async () => {
    const { runtime, call } = fixture();
    runtime.gitTopLevel = '/Users/alice';
    expect(await call('index_repository')).toMatchObject({ status: 'skipped' });
    expect(await call('search_graph', { query: 'answer' })).toMatchObject({ error: expect.stringContaining('not auto-indexed') });
    expect(runtime.shellCalls).toHaveLength(0);
    expect(await call('index_repository', { repo_path: '/Users/alice' })).toEqual({ project: 'fixture', status: 'indexed' });
    expect(runtime.shellCalls[0]).toMatchObject({
      command: expect.stringContaining('"repo_path":"/Users/alice","mode":"full"'),
      options: { timeout: INDEX_TIMEOUT_MS },
    });
    expect(runtime.files.has('codebase-memory/lru.json')).toBe(true);
    await expect(call('index_status')).resolves.toBeDefined();
  });

  it.each([
    ['delete_project', {}],
    ['manage_adr', {}],
    ['ingest_traces', {}],
    ['search_graph', []],
    ['search_graph', { repo_path: '/other' }],
    ['index_repository', { repo_path: '   ' }],
    ['index_repository', { persistence: true }],
    ['index_repository', { mode: 'cross-repo-intelligence', target_projects: ['*'] }],
  ])('rejects unsafe or invalid %s input before runtime I/O', async (command, args) => {
    const { runtime, call } = fixture();
    await expect(call(command, args)).rejects.toThrow();
    expect(runtime.execCalls).toHaveLength(0);
    expect(runtime.shellCalls).toHaveLength(0);
  });

  it('does not start I/O for an already cancelled call', async () => {
    const { runtime, call } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(call('list_projects', {}, controller.signal)).rejects.toThrow();
    expect(runtime.shellCalls).toHaveLength(0);
  });
});
