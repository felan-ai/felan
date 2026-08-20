import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverLocalSubagents } from '../src/subagents/catalog.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('explicit local Felan agent discovery', () => {
  it('uses cheap model and thinking settings only for the bundled explore agent', async () => {
    const root = await temporaryDirectory();
    const definitions = await discoverLocalSubagents(
      join(root, 'workspace'),
      join(root, 'home', '.felan'),
      join(root, 'home'),
    );
    const descriptors = Object.fromEntries(definitions.map((definition) => [
      definition.descriptor.id,
      definition.descriptor,
    ]));

    expect(Object.keys(descriptors)).toEqual(['general', 'explore', 'reviewer']);
    expect(descriptors.explore).toMatchObject({
      model: 'low',
      thinking: 'off',
    });
    for (const id of ['general', 'reviewer']) {
      expect(descriptors[id]).not.toHaveProperty('model');
      expect(descriptors[id]).not.toHaveProperty('thinking');
    }
  });

  it('loads shared and Felan definitions with project, user, then bundled precedence', async () => {
    const root = await temporaryDirectory();
    const home = join(root, 'home');
    const cwd = join(root, 'workspace');
    const agentDir = join(home, '.felan');
    await Promise.all([
      mkdir(join(home, '.agents', 'agents'), { recursive: true }),
      mkdir(join(cwd, '.agents', 'agents'), { recursive: true }),
      mkdir(join(cwd, '.felan', 'agents'), { recursive: true }),
      mkdir(join(cwd, '.pi', 'agents'), { recursive: true }),
      mkdir(join(agentDir, 'agents'), { recursive: true }),
    ]);
    await writeFile(join(home, '.agents', 'agents', 'shared-user.md'), definition('Shared user', 'Shared user prompt'));
    await writeFile(join(home, '.agents', 'agents', 'user-priority.md'), definition('Shared user priority', 'Shared user priority prompt'));
    await writeFile(join(agentDir, 'agents', 'user-priority.md'), definition('Felan user priority', 'Felan user priority prompt'));
    await writeFile(join(agentDir, 'agents', 'scope-priority.md'), definition('Felan user scope', 'Felan user scope prompt'));
    await writeFile(join(agentDir, 'agents', 'reviewer.md'), definition('User reviewer', 'User prompt'));
    await writeFile(join(cwd, '.agents', 'agents', 'reviewer.md'), definition('Shared project reviewer', 'Shared project prompt'));
    await writeFile(join(cwd, '.agents', 'agents', 'shared-project.md'), definition('Shared project', 'Shared project prompt'));
    await writeFile(join(cwd, '.agents', 'agents', 'scope-priority.md'), definition('Shared project scope', 'Shared project scope prompt'));
    await writeFile(join(cwd, '.felan', 'agents', 'reviewer.md'), definition('Project reviewer', 'Project prompt'));
    await writeFile(join(cwd, '.pi', 'agents', 'ambient.md'), definition('Ambient', 'Ambient prompt'));

    const definitions = await discoverLocalSubagents(cwd, agentDir, home);
    const reviewer = definitions.find((entry) => entry.descriptor.id === 'reviewer');

    expect(reviewer).toMatchObject({
      descriptor: { description: 'Project reviewer' },
      prompt: 'Project prompt',
    });
    expect(definitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ descriptor: expect.objectContaining({ id: 'shared-user' }) }),
      expect.objectContaining({ descriptor: expect.objectContaining({ id: 'shared-project' }) }),
      expect.objectContaining({
        descriptor: expect.objectContaining({ id: 'user-priority', description: 'Felan user priority' }),
        prompt: 'Felan user priority prompt',
      }),
      expect.objectContaining({
        descriptor: expect.objectContaining({ id: 'scope-priority', description: 'Shared project scope' }),
        prompt: 'Shared project scope prompt',
      }),
    ]));
    expect(definitions.map((entry) => entry.descriptor.id)).not.toContain('ambient');
  });

  it('parses declarative Felan fields and ignores unsupported policy fields', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await mkdir(join(cwd, '.felan', 'agents'), { recursive: true });
    await writeFile(join(cwd, '.felan', 'agents', 'worker.md'), [
      '---',
      'description: Worker',
      'model: provider/model',
      'thinking: max',
      'max_turns: 9',
      'timeout_seconds: 120',
      'allow_nesting: true',
      'capability: read-only',
      'extensions: arbitrary-package',
      '---',
      'Worker prompt',
    ].join('\n'));

    const definitions = await discoverLocalSubagents(cwd, agentDir);
    expect(definitions.find((entry) => entry.descriptor.id === 'worker')).toEqual({
      descriptor: {
        id: 'worker',
        description: 'Worker',
        model: 'provider/model',
        thinking: 'max',
        defaultMaxTurns: 9,
        defaultTimeoutSeconds: 120,
        allowNesting: true,
      },
      prompt: 'Worker prompt',
    });
  });

  it('rejects the unsupported minimal thinking value', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await mkdir(join(cwd, '.felan', 'agents'), { recursive: true });
    await writeFile(join(cwd, '.felan', 'agents', 'worker.md'), [
      '---',
      'description: Worker',
      'thinking: minimal',
      '---',
      'Worker prompt',
    ].join('\n'));

    await expect(discoverLocalSubagents(cwd, agentDir)).rejects.toThrow(
      'Felan agent worker.md has invalid thinking',
    );
  });
});

function definition(description: string, prompt: string): string {
  return `---\ndescription: ${description}\n---\n${prompt}`;
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-subagent-catalog-'));
  temporaryPaths.push(path);
  return path;
}
