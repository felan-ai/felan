import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const interactive = vi.hoisted(() => ({
  runs: 0,
  toolNames: [] as string[],
}));

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('@earendil-works/pi-coding-agent')>();
  return {
    ...original,
    InteractiveMode: class {
      constructor(private runtime: InstanceType<typeof original.AgentSessionRuntime>) {}

      async run() {
        interactive.runs += 1;
        interactive.toolNames = this.runtime.session.agent.state.tools.map((tool) => tool.name);
        await this.runtime.dispose();
      }
    },
  };
});

import { runLocalFelan } from '../src/application.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  interactive.runs = 0;
  interactive.toolNames = [];
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('interactive application', () => {
  it('runs Pi InteractiveMode with the composed local Agent Core runtime', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await mkdir(cwd, { recursive: true });

    await runLocalFelan({ cwd, agentDir });

    expect(interactive.runs).toBe(1);
    expect(interactive.toolNames).toEqual(expect.arrayContaining([
      'read',
      'bash',
      'spawn_agent',
    ]));
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-tui-application-'));
  temporaryPaths.push(path);
  return path;
}
