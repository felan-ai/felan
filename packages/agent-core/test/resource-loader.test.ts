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
    expect(loader.getSystemPrompt()).not.toContain('Be concise and direct');
    expect(loader.getSystemPrompt()).not.toContain('## Reporting');
    expect(loader.getSystemPrompt()).not.toMatch(/\bpi\b/i);
    expect(loader.getAppendSystemPrompt()).toEqual(['Consumer append']);
    expect(loader.getSystemPromptSource()).toBeUndefined();
    expect(loader.getAppendSystemPromptSources()).toEqual([]);
  });

  it('orders enabled extension capabilities before consumer appends and resets them on reload', async () => {
    const root = await temporaryDirectory();
    const runtime = new TestAgentRuntime(root);
    let eventGeneration = 0;
    const observedEventGenerations: number[] = [];
    const extensionsByName: Record<string, FelanExtension> = {
      '@felan-ai/one': (pi) => {
        pi.registerCapability({
          id: 'one',
          instructions: 'First capability.',
        });
        pi.events.on('felan:test-reload:v1', (data) => {
          if (typeof data === 'object' && data !== null && 'generation' in data
            && typeof data.generation === 'number') observedEventGenerations.push(data.generation);
        });
      },
      '@felan-ai/two': (pi) => {
        pi.registerCapability({
          id: 'two',
          instructions: 'Second capability.',
        });
        pi.events.emit('felan:test-reload:v1', { generation: ++eventGeneration });
      },
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
    expect(observedEventGenerations).toEqual([1]);

    loader.getExtensions().runtime.invalidate('test reload');
    await loader.reload();

    expect(loader.getAppendSystemPrompt()).toEqual([
      expectedCapabilities,
      'Consumer append',
    ]);
    expect(observedEventGenerations).toEqual([1, 2]);
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

  it('loads only explicit theme paths while ambient discovery stays disabled', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent-dir');
    const ambientThemes = join(agentDir, 'themes');
    const selectedTheme = join(root, 'selected-theme.json');
    await Promise.all([
      mkdir(cwd, { recursive: true }),
      mkdir(ambientThemes, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(ambientThemes, 'ambient.json'), themeJson('ambient-theme')),
      writeFile(selectedTheme, themeJson('selected-theme')),
    ]);

    const loader = await createAgentCoreResourceLoader({
      cwd,
      agentDir,
      extensionFactories: [],
      themePaths: [selectedTheme],
    });

    expect(loader.getThemes().diagnostics).toEqual([]);
    expect(loader.getThemes().themes.map(({ name }) => name)).toEqual(['selected-theme']);

    await loader.reload();

    expect(loader.getThemes().themes.map(({ name }) => name)).toEqual(['selected-theme']);
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

function themeJson(name: string): string {
  return JSON.stringify({
    name,
    vars: {
      text: '#e8e6e3',
      muted: '#928a87',
      dim: '#6f6864',
      accent: '#2f7f59',
      border: '#5e5652',
      surface: '#211e1c',
      success: '#21c45d',
      error: '#ef4343',
      warning: '#f59f0a',
      info: '#258cf4',
    },
    colors: {
      accent: 'accent', border: 'border', borderAccent: 'accent', borderMuted: 'dim',
      success: 'success', error: 'error', warning: 'warning', muted: 'muted', dim: 'dim',
      text: 'text', thinkingText: 'muted', selectedBg: 'surface', userMessageBg: 'surface',
      userMessageText: 'text', customMessageBg: 'surface', customMessageText: 'text',
      customMessageLabel: 'accent', toolPendingBg: 'surface', toolSuccessBg: 'surface',
      toolErrorBg: 'surface', toolTitle: 'accent', toolOutput: 'muted', mdHeading: 'accent',
      mdLink: 'info', mdLinkUrl: 'muted', mdCode: 'warning', mdCodeBlock: 'text',
      mdCodeBlockBorder: 'border', mdQuote: 'muted', mdQuoteBorder: 'border', mdHr: 'border',
      mdListBullet: 'accent', toolDiffAdded: 'success', toolDiffRemoved: 'error',
      toolDiffContext: 'muted', syntaxComment: 'dim', syntaxKeyword: 'accent',
      syntaxFunction: 'info', syntaxVariable: 'text', syntaxString: 'success',
      syntaxNumber: 'warning', syntaxType: 'info', syntaxOperator: 'muted',
      syntaxPunctuation: 'muted', thinkingOff: 'dim', thinkingMinimal: 'muted',
      thinkingLow: 'info', thinkingMedium: 'accent', thinkingHigh: 'warning',
      thinkingXhigh: 'error', bashMode: 'success',
    },
  });
}
