import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Skill } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentCoreResourceLoader } from '../src/index.js';

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
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-agent-core-'));
  temporaryPaths.push(path);
  return path;
}
