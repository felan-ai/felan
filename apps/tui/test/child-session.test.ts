import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const childRun = vi.hoisted(() => ({
  bindModes: [] as string[],
  prompts: [] as string[],
  disposed: 0,
  options: [] as unknown[],
}));

vi.mock('@felan-ai/agent-core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@felan-ai/agent-core')>();
  return {
    ...original,
    createAgentCoreSession: vi.fn(async (options: unknown) => {
      childRun.options.push(options);
      const messages: unknown[] = [];
      return {
        session: {
          messages,
          bindExtensions: async ({ mode }: { mode: string }) => {
            childRun.bindModes.push(mode);
          },
          prompt: async (prompt: string) => {
            childRun.prompts.push(prompt);
            messages.push({
              role: 'assistant',
              content: [{ type: 'text', text: 'Review complete' }],
              stopReason: 'stop',
            });
          },
          dispose: () => {
            childRun.disposed += 1;
          },
        },
      };
    }),
  };
});

import {
  HostAgentRuntime,
  type CreateAgentCoreSessionOptions,
} from '@felan-ai/agent-core';
import {
  createLocalModelRuntime,
  createLocalSessionHost,
} from '../src/runtime.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  childRun.bindModes = [];
  childRun.prompts = [];
  childRun.disposed = 0;
  childRun.options = [];
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('local child session host', () => {
  it('runs a child Agent Core session on a fresh host runtime', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    const modelRuntime = await createLocalModelRuntime(agentDir);
    const runtimes: HostAgentRuntime[] = [];
    const host = createLocalSessionHost({
      agentDir,
      modelRuntime,
      extensionPackages: [],
      importExtension: async () => {
        throw new Error('No extension import expected');
      },
      runtimeFactory: (runtimeCwd) => {
        const runtime = new HostAgentRuntime(runtimeCwd);
        runtimes.push(runtime);
        return runtime;
      },
    }, cwd);

    const result = await host.createChildSession({
      rootSessionId: 'root-1',
      parentSessionId: 'parent-1',
      personaId: 'reviewer',
      prompt: 'Review the implementation',
      block: true,
    });
    const options = childRun.options[0] as CreateAgentCoreSessionOptions;

    expect(result).toMatchObject({
      ok: true,
      status: 'completed',
      result: 'Review complete',
    });
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]?.cwd).toBe(cwd);
    expect(options.runtime).toBe(runtimes[0]);
    expect(options.host).not.toBe(host);
    expect(childRun.bindModes).toEqual(['print']);
    expect(childRun.prompts).toEqual(['Review the implementation']);
    expect(childRun.disposed).toBe(1);
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-tui-child-'));
  temporaryPaths.push(path);
  return path;
}
