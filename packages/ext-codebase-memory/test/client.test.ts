import type { AgentRuntimeStdioProcess, AgentRuntimeProcessSnapshot } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import { acquireCbmClient, CbmClient } from '../src/client.js';
import { envelope, MemoryRuntime, result } from './test-runtime.js';

describe('CbmClient stdio transport', () => {
  it.each([false, true])('reports pending calls until they settle (reject: %s)', async reject => {
    const gate = deferred();
    const entered = deferred();
    const runtime = new MemoryRuntime('daytona', true, async () => {
      entered.resolve();
      await gate.promise;
      if (reject) throw new Error('request failed');
      return result(envelope({ projects: [] }));
    });
    const client = new CbmClient(runtime, { command: 'codebase-memory-mcp', version: '0.11.0', source: 'path' });
    const call = client.call('list_projects', {});
    expect(client.hasPendingWork()).toBe(true);
    let idle = false;
    const waiting = client.waitForIdle().then(() => { idle = true; });
    await entered.promise;
    expect(idle).toBe(false);
    gate.resolve();
    if (reject) await expect(call).rejects.toThrow('request failed');
    else await call;
    await waiting;
    expect(client.hasPendingWork()).toBe(false);
    await client.close();
  });

  it('uses session-visible cache storage for one-shot cloud calls', async () => {
    const runtime = new (class extends MemoryRuntime {
      override async shell(command: string, options?: Record<string, unknown>) {
        this.shellCalls.push({ command, ...(options === undefined ? {} : { options }) });
        return result(envelope({ projects: [] }));
      }
    })('daytona', true, undefined, '/agent-storage', '/work/.felan');
    const client = new CbmClient(runtime, { command: 'codebase-memory-mcp', version: '0.11.0', source: 'path' });

    await client.call('list_projects', {});

    expect(runtime.shellCalls[0]?.options).toMatchObject({
      env: { CBM_CACHE_DIR: '/work/.felan/codebase-memory/cache' },
    });
  });

  it('reuses one frontend and closes it cleanly', async () => {
    const { runtime, startStdio } = fixture();
    const client = new CbmClient(runtime, { command: 'codebase-memory-mcp', version: '0.11.0', source: 'managed' });

    const request = client.call('list_projects', {});
    expect(client.hasPendingWork()).toBe(true);
    await expect(request).resolves.toMatchObject({
      data: { projects: [{ name: 'fixture' }] },
    });
    expect(client.hasPendingWork()).toBe(false);
    await expect(client.call('list_projects', {})).resolves.toMatchObject({
      data: { projects: [{ size_bytes: 7 }] },
    });
    await client.close();
    expect(startStdio).toHaveBeenCalledOnce();
    expect((await startStdio.mock.results[0]!.value).dispose).toHaveBeenCalled();
    await expect(client.call('list_projects', {})).rejects.toThrow('closed');
  });

  it('shares one frontend across runtimes in the same root session', async () => {
    const { runtime } = fixture();
    const child = fixture(runtime.storage('session').root).runtime;
    child.cwd = '/work/child';
    const other = fixture().runtime;
    const invocation = { command: 'codebase-memory-mcp', version: '0.11.0', source: 'managed' } as const;
    const rootLease = await acquireCbmClient(runtime, invocation);
    const childLease = await acquireCbmClient(child, invocation);
    const otherLease = await acquireCbmClient(other, invocation);

    try {
      expect(childLease.client).toBe(rootLease.client);
      expect(otherLease.client).not.toBe(rootLease.client);
      await expect(rootLease.client.call('list_projects', {})).resolves.toMatchObject({
        data: { projects: [{ name: 'fixture' }] },
      });
      await childLease.release();
      await expect(rootLease.client.call('list_projects', {})).resolves.toMatchObject({
        data: { projects: [{ size_bytes: 7 }] },
      });
      await rootLease.release();
      await expect(rootLease.client.call('list_projects', {})).rejects.toThrow('closed');
    } finally {
      await Promise.allSettled([rootLease.release(), childLease.release(), otherLease.release()]);
    }
  });

  it('waits for a closing frontend before reacquiring the same root session', async () => {
    const closing = deferred();
    const allowClose = deferred();
    const { runtime } = fixture(undefined, async () => { closing.resolve(); await allowClose.promise; });
    const invocation = { command: 'codebase-memory-mcp', version: '0.11.0', source: 'managed' } as const;
    const firstLease = await acquireCbmClient(runtime, invocation);
    await firstLease.client.call('list_projects', {});
    const releasing = firstLease.release();
    let reacquired = false;
    let nextLease: Awaited<ReturnType<typeof acquireCbmClient>> | undefined;
    const reacquiring = acquireCbmClient(runtime, invocation).then((lease) => {
      reacquired = true;
      nextLease = lease;
      return lease;
    });

    try {
      await closing.promise;
      expect(reacquired).toBe(false);
      allowClose.resolve();
      await releasing;
      const acquired = await reacquiring;
      expect(acquired.client).not.toBe(firstLease.client);
    } finally {
      allowClose.resolve();
      await releasing;
      await reacquiring;
      await nextLease?.release();
    }
  });

  it('closes a frontend that finishes starting during shutdown', async () => {
    const starting = deferred();
    const allowStart = deferred();
    const { runtime, startStdio } = fixture();
    const original = startStdio.getMockImplementation()!;
    startStdio.mockImplementation(async () => {
      starting.resolve();
      await allowStart.promise;
      return original();
    });
    const client = new CbmClient(runtime, { command: 'codebase-memory-mcp', version: '0.11.0', source: 'managed' });
    const call = client.call('list_projects', {});
    await starting.promise;

    const closing = client.close();
    allowStart.resolve();
    await Promise.allSettled([call]);
    await closing;

    const process = await startStdio.mock.results[0]!.value;
    expect(process.closeInput).toHaveBeenCalled();
    expect(process.dispose).toHaveBeenCalled();
  });
});

let nextSession = 0;

function fixture(sessionRoot = `/session-${++nextSession}`, beforeClose = async () => {}) {
  const startStdio = vi.fn(async () => stdioProcess(beforeClose));
  const runtime = Object.assign(new MemoryRuntime('host', true, undefined, '/agent-storage', sessionRoot), {
    processes: { startStdio, startShell: async () => { throw new Error('Unexpected shell process'); } },
  });
  return { runtime, startStdio };
}

function stdioProcess(beforeClose: () => Promise<void>) {
  let output = '';
  let running = true;
  let changed = deferred();
  const exited = deferred();
  const wake = () => { changed.resolve(); changed = deferred(); };
  const readStdout = async (offset: number): Promise<AgentRuntimeProcessSnapshot> => {
    while (running && offset >= output.length) await changed.promise;
    return { output: new TextEncoder().encode(output.slice(offset)), nextOffset: output.length, running };
  };
  const stop = () => { running = false; exited.resolve(); wake(); };
  return {
    pid: undefined,
    read: readStdout,
    readStdout,
    readStderr: async () => {
      await exited.promise;
      return { output: new Uint8Array(), nextOffset: 0, running: false };
    },
    write: async (content: Uint8Array) => {
      for (const line of new TextDecoder().decode(content).trim().split('\n')) {
        const message = JSON.parse(line);
        if (message.id === undefined) continue;
        const response = message.method === 'initialize'
          ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } }
          : JSON.parse(envelope({ projects: [{ name: 'fixture', root_path: '/work/repo', size_bytes: 7 }] }));
        output += JSON.stringify({ jsonrpc: '2.0', id: message.id, result: response }) + '\n';
        wake();
      }
    },
    closeInput: vi.fn(async () => { await beforeClose(); stop(); }),
    terminate: async () => { stop(); },
    dispose: vi.fn(async () => { stop(); }),
  } satisfies AgentRuntimeStdioProcess;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}
