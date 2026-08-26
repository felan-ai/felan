import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionConfigDefinition, SettingsManager } from '@felan-ai/agent-core';
import type { Component, Focusable } from '@earendil-works/pi-tui';
import { initTheme, VERSION as PI_VERSION } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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

    await setExtensionConfigValue(agentDir, 'prewalk', 'entryApproval', 'allow');

    const settings = getFelanSettings(createLocalSettingsManager(root, agentDir));
    expect(settings.extensionConfig?.prewalk?.entryApproval).toBe('allow');
    expect(getExtensionConfigOverrides(settings)).toEqual([{
      extensionId: 'prewalk',
      values: { entryApproval: 'allow' },
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

  it('preserves a configured sensitive value when its blank editor is submitted', () => {
    const definitions: readonly ExtensionConfigDefinition[] = [{
      id: 'webAccess',
      title: 'Web Access',
      fields: {
        openaiApiKey: {
          type: 'string',
          default: '',
          label: 'OpenAI API key',
          description: 'OpenAI credential source',
          sensitive: true,
        },
      },
    }];
    const settings = openExtensionSettings(
      definitions,
      '/tmp/felan-settings-test-unused',
      settingsWith({ extensionConfig: { webAccess: { openaiApiKey: '$OPENAI_API_KEY' } } }),
    );
    settings.handleInput?.('web');
    settings.handleInput?.('\r');
    expect(settings.render(100).join('\n')).toContain('configured');
    settings.handleInput?.('\r');
    expect(settings.render(100).join('\n')).toContain('Enter a value:');
    settings.handleInput?.('\r');
    expect(settings.render(100).join('\n')).toContain('configured');
  });

  it('keeps an editor open and reports invalid scalar input', () => {
    const definitions: readonly ExtensionConfigDefinition[] = [{
      id: 'powerline',
      title: 'Powerline',
      fields: {
        padding: {
          type: 'number',
          default: 1,
          description: 'Horizontal padding',
        },
      },
    }];
    const settings = openExtensionSettings(definitions);
    settings.handleInput?.('powerline');
    settings.handleInput?.('\r');
    settings.handleInput?.('\r');
    settings.handleInput?.('x');
    settings.handleInput?.('\r');
    const rendered = settings.render(100).join('\n');
    expect(rendered).toContain('Enter a value:');
    expect(rendered).toContain('Invalid value: Setting value must be a number');
  });

  it('rolls back an enum value when persistence fails', async () => {
    const root = await temporaryDirectory();
    const invalidAgentDir = join(root, 'not-a-directory');
    await writeFile(invalidAgentDir, 'file');
    const definitions: readonly ExtensionConfigDefinition[] = [{
      id: 'prewalk',
      title: 'Prewalk',
      fields: {
        entryApproval: {
          type: 'string',
          default: 'ask',
          description: 'Approval policy for model-entered Prewalk',
          values: ['ask', 'allow', 'deny'],
        },
      },
    }];
    const settings = openExtensionSettings(definitions, invalidAgentDir);
    settings.handleInput?.('prewalk');
    settings.handleInput?.('\r');
    settings.handleInput?.('\r');
    expect(settings.render(100).join('\n')).toContain('allow');
    settings.handleInput?.('\r');
    expect(settings.render(100).join('\n')).toContain('deny');
    await vi.waitFor(() => {
      expect(settings.render(100).join('\n')).toContain('ask (save failed)');
    });
  });

  it('groups extension settings into fuzzy-searchable submenus', () => {
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
            values: ['rewrite', 'suggest'],
          },
        },
      },
    ];
    const navigation = createExtensionSettingsHarness(definitions);
    navigation.current().handleInput?.('\r');
    expect(navigation.current().render(100).join('\n')).toContain('Native Pi settings');
    navigation.current().handleInput?.('\x1b');
    expect(navigation.current().render(100).join('\n')).toContain('Pi settings');

    const extensionSearch = openExtensionSettings(definitions);
    const rootItems = extensionSearch.render(100).join('\n');
    expect(rootItems).toContain('Pi settings');
    expect(rootItems).toContain('Web Access');
    expect(rootItems).toContain('RTK Optimizer');
    expect(rootItems).not.toContain('OpenAI API key');

    extensionSearch.handleInput?.('wbacc');
    const extensionResults = extensionSearch.render(100).join('\n');
    expect(extensionResults).toContain('Web Access');
    expect(extensionResults).not.toContain('RTK Optimizer');
    extensionSearch.handleInput?.('\r');
    const webAccessSettings = extensionSearch.render(100).join('\n');
    expect(webAccessSettings).toContain('OpenAI API key');
    expect(webAccessSettings).not.toContain('RTK Optimizer');
    extensionSearch.handleInput?.('\x1b');
    expect(extensionSearch.render(100).join('\n')).toContain('Web Access');

    const settingSearch = openExtensionSettings(definitions);
    settingSearch.handleInput?.('rtk');
    settingSearch.handleInput?.('\r');
    settingSearch.handleInput?.('mode');
    const settingResults = settingSearch.render(100).join('\n');
    expect(settingResults).toContain('Rewrite mode');
    expect(settingResults).not.toContain('OpenAI API key');
  });

  it('cycles and persists enum values from an extension submenu', async () => {
    const root = await temporaryDirectory();
    const agentDir = join(root, '.felan');
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'settings.json'), '{}\n');
    const manager = createLocalSettingsManager(root, agentDir);
    const definitions: readonly ExtensionConfigDefinition[] = [{
      id: 'prewalk',
      title: 'Prewalk',
      fields: {
        entryApproval: {
          type: 'string',
          default: 'ask',
          description: 'Approval policy for model-entered Prewalk',
          values: ['ask', 'allow', 'deny'],
        },
      },
    }];
    const harness = createExtensionSettingsHarness(definitions, agentDir, manager);
    const settings = harness.current();
    settings.handleInput?.('prewalk');
    settings.handleInput?.('\r');
    expect(settings.render(100).join('\n')).toContain('ask');

    settings.handleInput?.('\r');
    expect(settings.render(100).join('\n')).toContain('allow');
    settings.handleInput?.('\r');
    expect(settings.render(100).join('\n')).toContain('deny');
    settings.handleInput?.('\r');
    expect(settings.render(100).join('\n')).toContain('ask');
    await vi.waitFor(async () => {
      const persisted = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
      expect(persisted.extensionConfig.prewalk.entryApproval).toBe('ask');
    });
    await vi.waitFor(() => {
      expect(getFelanSettings(manager).extensionConfig?.prewalk?.entryApproval).toBe('ask');
    });

    harness.open();
    harness.current().handleInput?.('prewalk');
    harness.current().handleInput?.('\r');
    expect(harness.current().render(100).join('\n')).toContain('ask');
  });
});

interface ExtensionSettingsHarness {
  current(): Component;
  open(): void;
}

function createExtensionSettingsHarness(
  definitions: readonly ExtensionConfigDefinition[],
  agentDir = '/tmp/felan-settings-test-unused',
  settingsManager: SettingsManager = settingsWith({}),
): ExtensionSettingsHarness {
  let selector: { component: Component; focus: Focusable } | undefined;
  let nativeDone = () => {};
  const nativeSettings: Component & Focusable = {
    focused: false,
    render: () => ['Native Pi settings'],
    handleInput(data: string) {
      if (data === '\x1b') nativeDone();
    },
  };
  const mode: {
    showSettingsSelector(): void;
    showSelector(create: (done: () => void) => { component: Component; focus: Focusable }): void;
  } = {
    showSettingsSelector() {
      mode.showSelector((done) => {
        nativeDone = done;
        return { component: nativeSettings, focus: nativeSettings };
      });
    },
    showSelector(create: (done: () => void) => { component: Component; focus: Focusable }) {
      selector = create(() => {});
    },
  };
  installFelanSettingsCommand(mode, {
    agentDir,
    settingsManager,
    definitions,
  });
  const current = (): Component => {
    if (!selector) throw new Error('Settings selector was not created');
    return selector.component;
  };
  mode.showSettingsSelector();
  return { current, open: () => mode.showSettingsSelector() };
}

function openExtensionSettings(
  definitions: readonly ExtensionConfigDefinition[],
  agentDir = '/tmp/felan-settings-test-unused',
  settingsManager: SettingsManager = settingsWith({}),
): Component {
  return createExtensionSettingsHarness(definitions, agentDir, settingsManager).current();
}

function settingsWith(settings: Record<string, unknown>): SettingsManager {
  return { getGlobalSettings: () => settings } as unknown as SettingsManager;
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-tui-settings-'));
  temporaryPaths.push(path);
  return path;
}
