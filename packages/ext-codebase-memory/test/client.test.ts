import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HostAgentRuntime,
  type AgentRuntime,
  type AgentRuntimeStdioProcessOptions,
} from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireCbmClient, CbmClient } from '../src/client.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('CbmClient stdio transport', () => {
  it('initializes once, reuses one frontend, and closes it cleanly', async () => {
    const { workspace, session, agent, script } = await fixture();
    const runtime = new HostAgentRuntime(workspace, { sessionStorageRoot: session, agentStorageRoot: agent });
    const client = new CbmClient(runtime, { command: script, version: '0.10.8', source: 'managed' });

    await expect(client.call('list_projects', {})).resolves.toMatchObject({
      data: { projects: [{ name: 'fixture' }] },
    });
    await expect(client.call('list_projects', {})).resolves.toMatchObject({
      data: { projects: [{ size_bytes: 7 }] },
    });
    await client.close();
    await expect(client.call('list_projects', {})).rejects.toThrow('closed');
  });

  it('shares one frontend across runtimes in the same root session', async () => {
    const { root, workspace, session, agent, script } = await fixture();
    const childWorkspace = join(root, 'child-workspace');
    const otherSession = join(root, 'other-session');
    await Promise.all([
      mkdir(childWorkspace, { recursive: true }),
      mkdir(otherSession, { recursive: true }),
    ]);
    const invocation = { command: script, version: '0.10.8', source: 'managed' } as const;
    const rootLease = await acquireCbmClient(
      new HostAgentRuntime(workspace, { sessionStorageRoot: session, agentStorageRoot: agent }),
      invocation,
    );
    const childLease = await acquireCbmClient(
      new HostAgentRuntime(childWorkspace, { sessionStorageRoot: session, agentStorageRoot: agent }),
      invocation,
    );
    const otherLease = await acquireCbmClient(
      new HostAgentRuntime(workspace, { sessionStorageRoot: otherSession, agentStorageRoot: agent }),
      invocation,
    );

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
    const { workspace, session, agent, script } = await fixture(150);
    const runtime = new HostAgentRuntime(workspace, { sessionStorageRoot: session, agentStorageRoot: agent });
    const invocation = { command: script, version: '0.10.8', source: 'managed' } as const;
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
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(reacquired).toBe(false);
      await releasing;
      const acquired = await reacquiring;
      expect(acquired.client).not.toBe(firstLease.client);
    } finally {
      await releasing;
      await reacquiring;
      await nextLease?.release();
    }
  });

  it('closes a frontend that finishes starting during shutdown', async () => {
    const { workspace, session, agent, script } = await fixture();
    const base = new HostAgentRuntime(workspace, { sessionStorageRoot: session, agentStorageRoot: agent });
    const ensureStarted = deferred();
    const allowEnsure = deferred();
    let pid: number | undefined;
    const runtime = {
      kind: base.kind,
      cwd: base.cwd,
      storage: base.storage.bind(base),
      privateRuntime: {
        ensureDirectory: async (namespace: string) => {
          ensureStarted.resolve();
          await allowEnsure.promise;
          return base.privateRuntime.ensureDirectory(namespace);
        },
      },
      processes: {
        startStdio: async (
          command: string,
          args: readonly string[],
          options?: AgentRuntimeStdioProcessOptions,
        ) => {
          const handle = await base.processes.startStdio!(command, args, options);
          pid = handle.pid;
          return handle;
        },
      },
    } as AgentRuntime;
    const client = new CbmClient(runtime, { command: script, version: '0.10.8', source: 'managed' });
    const call = client.call('list_projects', {});
    await ensureStarted.promise;

    const closing = client.close();
    allowEnsure.resolve();
    await Promise.allSettled([call]);
    await closing;

    expect(pid).toBeDefined();
    await vi.waitFor(() => expect(isProcessRunning(pid!)).toBe(false));
  });
});

async function fixture(closeDelayMs = 0): Promise<{
  root: string;
  workspace: string;
  session: string;
  agent: string;
  script: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'felan-cbm-client-'));
  temporaryRoots.push(root);
  const workspace = join(root, 'workspace');
  const session = join(root, 'session');
  const agent = join(root, 'agent');
  const script = join(root, 'cbm-fixture.mjs');
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(session, { recursive: true }),
    mkdir(agent, { recursive: true }),
    writeFile(script, `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
process.stdin.on('end', () => setTimeout(() => {}, ${closeDelayMs}));
let pending = '';
process.stdin.on('data', (chunk) => {
  pending += chunk;
  for (;;) {
    const newline = pending.indexOf('\\n');
    if (newline < 0) break;
    const message = JSON.parse(pending.slice(0, newline));
    pending = pending.slice(newline + 1);
    if (message.id === undefined) continue;
    const result = message.method === 'initialize'
      ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } }
      : { content: [{ type: 'text', text: JSON.stringify({ projects: [{ name: 'fixture', root_path: '/work/repo', size_bytes: 7 }] }) }] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
  }
});
`),
    writeFile(join(workspace, 'answer.ts'), 'export const answer = 42;'),
  ]);
  await chmod(script, 0o700);
  return { root, workspace, session, agent, script };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}
