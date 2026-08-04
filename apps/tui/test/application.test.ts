import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const interactive = vi.hoisted(() => ({
  agentDirs: [] as Array<string | undefined>,
  constructorError: undefined as Error | undefined,
  disposals: 0,
  runError: undefined as Error | undefined,
  runs: 0,
  toolNames: [] as string[],
}));

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>();
  return {
    ...original,
    InteractiveMode: class {
      constructor(private runtime: InstanceType<typeof original.AgentSessionRuntime>) {
        interactive.agentDirs.push(process.env.PI_CODING_AGENT_DIR);
        const dispose = runtime.dispose.bind(runtime);
        runtime.dispose = async () => {
          interactive.disposals += 1;
          await dispose();
        };
        if (interactive.constructorError) throw interactive.constructorError;
      }

      async run() {
        interactive.runs += 1;
        interactive.toolNames = this.runtime.session.agent.state.tools.map((tool) => tool.name);
        if (interactive.runError) throw interactive.runError;
      }
    },
  };
});

import { runLocalFelan } from '../src/application.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  interactive.agentDirs = [];
  interactive.constructorError = undefined;
  interactive.disposals = 0;
  interactive.runError = undefined;
  interactive.runs = 0;
  interactive.toolNames = [];
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('interactive application', () => {
  it('runs Pi InteractiveMode with the composed local Agent Core runtime', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
    await mkdir(cwd, { recursive: true });

    await runLocalFelan({ cwd, agentDir });

    expect(interactive.runs).toBe(1);
    expect(interactive.agentDirs).toEqual([agentDir]);
    expect(interactive.disposals).toBe(1);
    expect(process.env.PI_CODING_AGENT_DIR).toBe(previousPiAgentDir);
    expect(interactive.toolNames).toEqual(expect.arrayContaining([
      'read',
      'bash',
      'Agent',
      'list_subagents',
      'get_subagent_result',
      'steer_subagent',
      'cancel_subagent',
    ]));
    expect(interactive.toolNames).not.toContain('spawn_agent');
  });

  it('disposes the runtime when InteractiveMode construction fails', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await mkdir(cwd, { recursive: true });
    interactive.constructorError = new Error('constructor failed');

    await expect(runLocalFelan({ cwd, agentDir })).rejects.toThrow('constructor failed');

    expect(interactive.runs).toBe(0);
    expect(interactive.disposals).toBe(1);
  });

  it('disposes the runtime when InteractiveMode.run fails', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await mkdir(cwd, { recursive: true });
    interactive.runError = new Error('run failed');

    await expect(runLocalFelan({ cwd, agentDir })).rejects.toThrow('run failed');

    expect(interactive.runs).toBe(1);
    expect(interactive.disposals).toBe(1);
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-tui-application-'));
  temporaryPaths.push(path);
  return path;
}
