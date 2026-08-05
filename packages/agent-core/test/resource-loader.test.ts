import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Skill } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FELAN_BASE_SYSTEM_PROMPT,
  createAgentCoreResourceLoader,
  loadFelanExtensions,
  type FelanExtension,
} from '../src/index.js';
import { TestAgentRuntime } from './test-agent-runtime.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  delete (globalThis as { ambientFelanExtension?: boolean }).ambientFelanExtension;
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('Agent Core resource loading', () => {
  it('loads only inline factories and ignores ambient project and user extensions', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent-dir');
    const projectExtensions = join(cwd, '.pi', 'extensions');
    const userExtensions = join(agentDir, 'extensions');
    await mkdir(projectExtensions, { recursive: true });
    await mkdir(userExtensions, { recursive: true });
    const ambientSource = 'globalThis.ambientFelanExtension = true; export default () => {};';
    await writeFile(join(projectExtensions, 'project.js'), ambientSource);
    await writeFile(join(userExtensions, 'user.js'), ambientSource);

    const loader = await createAgentCoreResourceLoader({
      cwd,
      agentDir,
      extensionFactories: [{ name: '@felan-ai/listed', factory: () => {} }],
    });

    expect(loader.getExtensions().extensions.map((extension) => extension.path)).toEqual([
      '<inline:@felan-ai/listed>',
    ]);
    expect((globalThis as { ambientFelanExtension?: boolean }).ambientFelanExtension).toBeUndefined();
    expect(loader.getSkills()).toEqual({ skills: [], diagnostics: [] });
    expect(loader.getPrompts()).toEqual({ prompts: [], diagnostics: [] });
    expect(loader.getAgentsFiles()).toEqual({ agentsFiles: [] });
  });

  it('always uses the Felan core prompt and ignores ambient prompt files', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent-dir');
    await Promise.all([
      mkdir(join(cwd, '.pi'), { recursive: true }),
      mkdir(agentDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(cwd, '.pi', 'SYSTEM.md'), 'Project replacement'),
      writeFile(join(cwd, '.pi', 'APPEND_SYSTEM.md'), 'Project append'),
      writeFile(join(agentDir, 'SYSTEM.md'), 'Ambient replacement'),
      writeFile(join(agentDir, 'APPEND_SYSTEM.md'), 'Ambient append'),
    ]);

    const loader = await createAgentCoreResourceLoader({
      cwd,
      agentDir,
      extensionFactories: [],
      appendSystemPrompt: ['Consumer append'],
    });

    expect(loader.getSystemPrompt()).toBe(FELAN_BASE_SYSTEM_PROMPT);
    expect(loader.getSystemPrompt()).not.toMatch(/\bpi\b/i);
    expect(loader.getAppendSystemPrompt()).toEqual(['Consumer append']);
    expect(loader.getSystemPromptSource()).toBeUndefined();
    expect(loader.getAppendSystemPromptSources()).toEqual([]);
  });

  it('orders enabled extension capabilities before consumer appends and resets them on reload', async () => {
    const root = await temporaryDirectory();
    const runtime = new TestAgentRuntime(root);
    const extensionsByName: Record<string, FelanExtension> = {
      '@felan-ai/one': (pi) => pi.registerCapability({
        id: 'one',
        instructions: 'First capability.',
      }),
      '@felan-ai/two': (pi) => pi.registerCapability({
        id: 'two',
        instructions: 'Second capability.',
      }),
      '@felan-ai/disabled': (pi) => pi.registerCapability({
        id: 'disabled',
        instructions: 'Disabled capability.',
      }),
    };
    const extensionFactories = await loadFelanExtensions(
      ['@felan-ai/one', '@felan-ai/two'],
      async (packageName) => ({ default: extensionsByName[packageName] }),
      runtime,
    );
    const loader = await createAgentCoreResourceLoader({
      cwd: root,
      agentDir: join(root, 'agent-dir'),
      extensionFactories,
      appendSystemPrompt: ['Consumer append'],
    });

    const expectedCapabilities = [
      '## Enabled capabilities',
      '',
      '### one',
      '',
      'First capability.',
      '',
      '### two',
      '',
      'Second capability.',
    ].join('\n');
    expect(loader.getAppendSystemPrompt()).toEqual([
      expectedCapabilities,
      'Consumer append',
    ]);
    expect(loader.getAppendSystemPrompt().join('\n')).not.toContain('Disabled capability.');

    await loader.reload();

    expect(loader.getAppendSystemPrompt()).toEqual([
      expectedCapabilities,
      'Consumer append',
    ]);
  });

  it('rejects duplicate and invalid capability registrations with extension sources', async () => {
    const root = await temporaryDirectory();
    const runtime = new TestAgentRuntime(root);
    const duplicateFactories = await loadFelanExtensions(
      ['@felan-ai/one', '@felan-ai/two'],
      async (packageName) => ({
        default: ((pi) => pi.registerCapability({
          id: 'shared',
          instructions: packageName,
        })) satisfies FelanExtension,
      }),
      runtime,
    );

    await expect(createAgentCoreResourceLoader({
      cwd: root,
      agentDir: join(root, 'agent-dir'),
      extensionFactories: duplicateFactories,
    })).rejects.toThrow(
      'Duplicate capability id shared from @felan-ai/two; already registered by @felan-ai/one',
    );

    const invalidFactories = await loadFelanExtensions(
      ['@felan-ai/invalid'],
      async () => ({
        default: ((pi) => pi.registerCapability({
          id: 'Invalid capability',
          instructions: 'Instructions',
        })) satisfies FelanExtension,
      }),
      runtime,
    );
    await expect(createAgentCoreResourceLoader({
      cwd: root,
      agentDir: join(root, 'agent-dir'),
      extensionFactories: invalidFactories,
    })).rejects.toThrow('Invalid capability id from @felan-ai/invalid');
  });

  it('reports inline initialization failures with the package name', async () => {
    const root = await temporaryDirectory();
    await expect(createAgentCoreResourceLoader({
      cwd: root,
      agentDir: join(root, 'agent-dir'),
      extensionFactories: [{
        name: '@felan-ai/broken',
        factory: () => {
          throw new Error('initialization failed');
        },
      }],
    })).rejects.toThrow('<inline:@felan-ai/broken>: initialization failed');
  });

  it('uses only app-supplied skills while ambient discovery stays disabled', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent-dir');
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, 'SKILL.md'), '---\nname: ambient\ndescription: Ambient\n---\n');
    const skillPath = join(root, 'selected', 'SKILL.md');
    const selected: Skill = {
      name: 'selected',
      description: 'Selected by the application',
      filePath: skillPath,
      baseDir: join(root, 'selected'),
      sourceInfo: {
        path: skillPath,
        source: 'app:selected',
        scope: 'temporary',
        origin: 'top-level',
      },
      disableModelInvocation: false,
    };

    const loader = await createAgentCoreResourceLoader({
      cwd,
      agentDir,
      extensionFactories: [],
      skills: [selected],
    });

    expect(loader.getSkills()).toEqual({ skills: [selected], diagnostics: [] });
  });

  it('loads only explicit skill paths while ambient discovery stays disabled', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent-dir');
    const selectedDir = join(root, 'selected');
    const ambientDir = join(agentDir, 'skills', 'ambient');
    await Promise.all([
      mkdir(selectedDir, { recursive: true }),
      mkdir(ambientDir, { recursive: true }),
    ]);
    await writeFile(join(selectedDir, 'SKILL.md'), skill('selected', 'Selected skill'));
    await writeFile(join(ambientDir, 'SKILL.md'), skill('ambient', 'Ambient skill'));

    const loader = await createAgentCoreResourceLoader({
      cwd,
      agentDir,
      extensionFactories: [],
      skillPaths: [selectedDir],
    });

    expect(loader.getSkills().skills.map(({ name }) => name)).toEqual(['selected']);
  });
});

function skill(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n`;
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-agent-core-'));
  temporaryPaths.push(path);
  return path;
}
