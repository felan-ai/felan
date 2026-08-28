import { describe, expect, it } from 'vitest';
import { CbmClient } from '../src/cbm/client.js';
import { MemoryRuntime, result } from './test-runtime.js';

describe('CbmClient', () => {
  it('uses runtime.exec for CBM and git with bounded output and explicit env', async () => {
    const runtime = new MemoryRuntime(async (command) => {
      if (command === 'git') return result('/workspace/repository\n');
      return result(JSON.stringify({ content: [{ type: 'text', text: '{"results":[1]}' }] }));
    });
    const client = new CbmClient(runtime, '/usr/local/bin/codebase-memory-mcp', { queryTimeoutMs: 12_345 });

    await expect(client.findGitRoot('/workspace/repository/src')).resolves.toBe('/workspace/repository');
    await expect(client.callTool('search_code', { query: 'needle' })).resolves.toMatchObject({
      ok: true,
      data: { results: [1] },
    });

    expect(runtime.execCalls).toEqual([
      expect.objectContaining({ command: 'git', args: ['rev-parse', '--show-toplevel'] }),
      expect.objectContaining({
        command: '/usr/local/bin/codebase-memory-mcp',
        args: ['cli', '--json', 'search_code', '{"query":"needle"}'],
        options: expect.objectContaining({
          timeout: 12_345,
          maxOutputBytes: 5 * 1024 * 1024,
          env: {
            CBM_SQLITE_MMAP_SIZE: '0',
            HOME: '/agent-storage/codebase-memory/home',
            XDG_CACHE_HOME: '/agent-storage/codebase-memory/cache',
          },
        }),
      }),
    ]);
  });

  it('surfaces cancellation, truncation, process failures, and CBM errors', async () => {
    const truncated = new CbmClient(new MemoryRuntime(async () => ({
      ...result('{}'),
      truncated: true,
    })), 'cbm');
    await expect(truncated.callTool('search_code', {})).rejects.toThrow('exceeded');

    const failed = new CbmClient(new MemoryRuntime(async () => result('', 2, 'bad request')), 'cbm');
    await expect(failed.callTool('search_code', {})).rejects.toThrow('bad request');

    const cbmError = new CbmClient(new MemoryRuntime(async () => result(JSON.stringify({
      isError: true,
      content: [{ type: 'text', text: 'invalid query' }],
    }))), 'cbm');
    await expect(cbmError.callTool('search_code', {})).rejects.toThrow('invalid query');
    await expect(cbmError.callTool('search_code', {}, { allowError: true })).resolves.toMatchObject({ ok: false });
  });
});
