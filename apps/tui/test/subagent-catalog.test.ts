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
  it('uses project, user, then bundled precedence without Pi discovery', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await Promise.all([
      mkdir(join(cwd, '.felan', 'agents'), { recursive: true }),
      mkdir(join(cwd, '.pi', 'agents'), { recursive: true }),
      mkdir(join(agentDir, 'agents'), { recursive: true }),
    ]);
    await writeFile(join(agentDir, 'agents', 'reviewer.md'), definition('User reviewer', 'User prompt'));
    await writeFile(join(cwd, '.felan', 'agents', 'reviewer.md'), definition('Project reviewer', 'Project prompt'));
    await writeFile(join(cwd, '.pi', 'agents', 'ambient.md'), definition('Ambient', 'Ambient prompt'));

    const definitions = await discoverLocalSubagents(cwd, agentDir);
    const reviewer = definitions.find((entry) => entry.descriptor.id === 'reviewer');

    expect(reviewer).toMatchObject({
      descriptor: { description: 'Project reviewer' },
      prompt: 'Project prompt',
    });
    expect(definitions.map((entry) => entry.descriptor.id)).not.toContain('ambient');
  });

  it('parses only declarative Felan policy fields', async () => {
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
      'capability: coding',
      'extensions: arbitrary-package',
      '---',
      'Worker prompt',
    ].join('\n'));

    const definitions = await discoverLocalSubagents(cwd, agentDir);
    expect(definitions.find((entry) => entry.descriptor.id === 'worker')).toEqual({
      descriptor: {
        id: 'worker',
        description: 'Worker',
        defaultModel: 'provider/model',
        defaultThinking: 'max',
        defaultMaxTurns: 9,
        defaultTimeoutSeconds: 120,
        allowNesting: true,
      },
      prompt: 'Worker prompt',
      capability: 'coding',
    });
  });

  it('normalizes read-only definitions to leaf agents', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    await mkdir(join(cwd, '.felan', 'agents'), { recursive: true });
    await writeFile(join(cwd, '.felan', 'agents', 'reader.md'), [
      '---',
      'description: Reader',
      'allow_nesting: true',
      'capability: read-only',
      '---',
      'Read only',
    ].join('\n'));

    const definitions = await discoverLocalSubagents(cwd, agentDir);
    expect(definitions.find((entry) => entry.descriptor.id === 'reader')).toMatchObject({
      capability: 'read-only',
      descriptor: { allowNesting: false },
    });
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
