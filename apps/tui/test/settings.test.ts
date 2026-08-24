import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionConfigDefinition, SettingsManager } from '@felan-ai/agent-core';
import type { Component, Focusable } from '@earendil-works/pi-tui';
import { initTheme, VERSION as PI_VERSION } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createLocalSettingsManager,
  getDependencyOnboardingChoice,
  getFelanSettings,
  getLocalMemoryProcessingEnabled,
  getLocalOutputStyle,
  getLocalToolDisplayMode,
  isBuiltinExtensionEnabled,
  setBuiltinExtensionEnabled,
  setDependencyOnboardingChoice,
  getExtensionConfigOverrides,
  setExtensionConfigValue,
  setLocalMemoryProcessingEnabled,
} from '../src/settings.js';
import {
  formatExtensionSettingDisplayValue,
  installFelanSettingsCommand,
  parseExtensionSettingValue,
} from '../src/extension-settings.js';

const temporaryPaths: string[] = [];

beforeAll(() => initTheme('dark', false));

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('local settings', () => {
  it('preserves terminal and model settings while filtering executable resources', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, '.felan');
    await mkdir(join(cwd, '.pi'), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
      quietStartup: true,
      defaultProvider: 'anthropic',
      defaultModel: 'test-model',
      builtinExtensions: { prewalk: false },
      outputStyle: 'explanatory',
      felanSubagents: { concurrency: 2 },
      felanTui: { toolDisplay: 'full' },
      packages: ['npm:untrusted-package'],
      extensions: ['/tmp/untrusted-extension.ts'],
      skills: ['/tmp/untrusted-skill'],
      prompts: ['/tmp/untrusted-prompt'],
      themes: ['/tmp/untrusted-theme'],
    }));
    await writeFile(join(cwd, '.pi', 'settings.json'), JSON.stringify({
      defaultModel: 'project-model',
    }));

    const settings = createLocalSettingsManager(cwd, agentDir);

    expect(settings.getQuietStartup()).toBe(true);
    expect(settings.getDefaultProvider()).toBe('anthropic');
    expect(settings.getDefaultModel()).toBe('test-model');
    expect(settings.isProjectTrusted()).toBe(true);
    expect(settings.getPackages()).toEqual([]);
    expect(settings.getExtensionPaths()).toEqual([]);
    expect(settings.getSkillPaths()).toEqual([]);
    expect(settings.getPromptTemplatePaths()).toEqual([]);
    expect(settings.getThemePaths()).toEqual([]);
    expect(settings.getEnableInstallTelemetry()).toBe(false);
    expect(settings.getLastChangelogVersion()).toBe(PI_VERSION);
    expect(settings.getGlobalSettings().packages).toEqual([]);
    expect(settings.getProjectSettings().packages).toEqual([]);
    expect(settings.getProjectSettings().defaultModel).toBeUndefined();
    expect(getFelanSettings(settings)).toMatchObject({
      builtinExtensions: { prewalk: false },
      outputStyle: 'explanatory',
      felanSubagents: { concurrency: 2 },
      felanTui: { toolDisplay: 'full' },
    });
    expect(getLocalToolDisplayMode(settings)).toBe('full');
    expect(getLocalOutputStyle(settings)).toBe('explanatory');

    await settings.reload();

    settings.setProjectTrusted(false);
    expect(settings.isProjectTrusted()).toBe(true);
    expect(settings.getDefaultModel()).toBe('test-model');
    expect(settings.getPackages()).toEqual([]);
    expect(settings.getEnableInstallTelemetry()).toBe(false);
    expect(settings.getLastChangelogVersion()).toBe(PI_VERSION);
    expect(settings.getGlobalSettings().packages).toEqual([]);
  });

  it('defaults to grouped tool display and rejects invalid values', () => {
    expect(getLocalToolDisplayMode(settingsWith({}))).toBe('grouped');
    expect(() => getLocalToolDisplayMode(settingsWith({ felanTui: 'grouped' })))
      .toThrow('felanTui must be an object');
    expect(() => getLocalToolDisplayMode(settingsWith({ felanTui: { toolDisplay: 'compact' } })))
      .toThrow('felanTui.toolDisplay must be "grouped" or "full"');
  });

  it('defaults output style to concise and rejects invalid values', () => {
    expect(getLocalOutputStyle(settingsWith({}))).toBe('concise');
    expect(getLocalOutputStyle(settingsWith({ outputStyle: 'explanatory' }))).toBe('explanatory');
    expect(() => getLocalOutputStyle(settingsWith({ outputStyle: 'verbose' })))
      .toThrow('outputStyle must be one of: concise, explanatory');
    expect(() => getLocalOutputStyle(settingsWith({ outputStyle: { path: '/tmp/prompt' } })))
      .toThrow('outputStyle must be one of: concise, explanatory');
  });

  it('persists dependency choices without replacing unrelated global settings', async () => {
    const root = await temporaryDirectory();
    const agentDir = join(root, '.felan');
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
      defaultProvider: 'anthropic',
      felanTui: { toolDisplay: 'full' },
    }));

    await Promise.all([
      setBuiltinExtensionEnabled(agentDir, 'markitdown', false),
      setDependencyOnboardingChoice(agentDir, 'rtk', 'continue'),
    ]);

    const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
    expect(settings).toMatchObject({
      defaultProvider: 'anthropic',
      builtinExtensions: { markitdown: false },
      felanTui: {
        toolDisplay: 'full',
        dependencyOnboarding: { rtk: 'continue' },
      },
    });
    expect(isBuiltinExtensionEnabled(settings, 'markitdown')).toBe(false);
    expect(getDependencyOnboardingChoice(settings, 'rtk')).toBe('continue');
    const manager = createLocalSettingsManager(root, agentDir);
    expect(getDependencyOnboardingChoice(getFelanSettings(manager), 'rtk')).toBe('continue');
    expect(getLocalMemoryProcessingEnabled(manager)).toBe(true);

    await setLocalMemoryProcessingEnabled(agentDir, false);
    expect(getLocalMemoryProcessingEnabled(createLocalSettingsManager(root, agentDir))).toBe(false);

    await setDependencyOnboardingChoice(agentDir, 'rtk', undefined);
    const cleared = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
    expect(cleared.felanTui).toEqual({ toolDisplay: 'full', memoryProcessing: false });
  });

  it('defaults memory processing on and rejects invalid values', () => {
    expect(getLocalMemoryProcessingEnabled(settingsWith({}))).toBe(true);
    expect(() => getLocalMemoryProcessingEnabled(settingsWith({ felanTui: { memoryProcessing: 'yes' } })))
      .toThrow('felanTui.memoryProcessing must be a boolean');
  });

  it('persists namespaced extension configuration without replacing unrelated settings', async () => {
    const root = await temporaryDirectory();
    const agentDir = join(root, '.felan');
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ defaultModel: 'model', outputStyle: 'concise' }));

    await setExtensionConfigValue(agentDir, 'prewalk', 'entryApproval', 'always');

    const settings = getFelanSettings(createLocalSettingsManager(root, agentDir));
    expect(settings.extensionConfig?.prewalk?.entryApproval).toBe('always');
    expect(getExtensionConfigOverrides(settings)).toEqual([{
      extensionId: 'prewalk',
      values: { entryApproval: 'always' },
      source: 'settings.json.extensionConfig.prewalk',
    }]);
  });

  it('redacts sensitive extension values in settings presentation', async () => {
    const field = {
      type: 'string' as const,
      default: '',
      description: 'Credential source',
      sensitive: true,
    };
    expect(formatExtensionSettingDisplayValue(field, '$OPENAI_API_KEY')).toBe('configured');
    expect(formatExtensionSettingDisplayValue(field, '')).toBe('not set');
    expect(parseExtensionSettingValue(field, '')).toBe('');
    expect(parseExtensionSettingValue(field, '$OPENAI_API_KEY')).toBe('$OPENAI_API_KEY');
  });

  it('fuzzy-searches extension settings by extension and setting names', () => {
    const definitions: readonly ExtensionConfigDefinition[] = [
      {
        id: 'webAccess',
        title: 'Web Access',
        fields: {
          openaiApiKey: {
            type: 'string',
            default: '',
            label: 'OpenAI API key',
            description: 'OpenAI credential source',
          },
        },
      },
      {
        id: 'rtkOptimizer',
        title: 'RTK Optimizer',
        fields: {
          mode: {
            type: 'string',
            default: 'rewrite',
            label: 'Rewrite mode',
            description: 'Command rewrite mode',
          },
        },
      },
    ];
    const openSettings = (): Component => {
      let selector: { component: Component; focus: Focusable } | undefined;
      const mode = {
        showSettingsSelector() {},
        showSelector(create: (done: () => void) => { component: Component; focus: Focusable }) {
          selector = create(() => {});
        },
      };
      installFelanSettingsCommand(mode, {
        agentDir: '/tmp/.felan',
        settingsManager: settingsWith({}),
        definitions,
      });
      mode.showSettingsSelector();
      if (!selector) throw new Error('Settings selector was not created');
      return selector.component;
    };

    const extensionSearch = openSettings();
    extensionSearch.handleInput?.('wbacc');
    const extensionResults = extensionSearch.render(100).join('\n');
    expect(extensionResults).toContain('Web Access: OpenAI API key');
    expect(extensionResults).not.toContain('RTK Optimizer: Rewrite mode');

    const settingSearch = openSettings();
    settingSearch.handleInput?.('rtk mode');
    const settingResults = settingSearch.render(100).join('\n');
    expect(settingResults).toContain('RTK Optimizer: Rewrite mode');
    expect(settingResults).not.toContain('Web Access: OpenAI API key');
  });
});

function settingsWith(settings: Record<string, unknown>): SettingsManager {
  return { getGlobalSettings: () => settings } as unknown as SettingsManager;
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-tui-settings-'));
  temporaryPaths.push(path);
  return path;
}
