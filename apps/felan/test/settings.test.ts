import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configField,
  defineExtensionConfig,
  type SettingsManager,
} from '@felan-ai/agent-core';
import { OUTPUT_STYLE_CONFIG } from '@felan-ai/ext-output-style';
import { VERSION as PI_VERSION } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLocalSettingsManager,
  getDynamicThinkingEnabled,
  getLocalCodemodeMode,
  getFelanSettings,
  getPiExtensionSettings,
  isDependencyOnboardingComplete,
  isBuiltinExtensionEnabled,
  setDependencyOnboardingDecision,
  resolveExtensionConfigSettings,
  setLocalCodemodeMode,
} from '../src/providers/settings.js';
import { DaemonConfiguration } from '../src/providers/configuration.js';
import { mergeDaemonGlobalSettings } from '../src/providers/global-settings.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('local settings', () => {
  it('keeps bundled Pi llama.cpp opt-in and validates the setting', () => {
    const root = '/tmp/felan-pi-llama-settings-test';
    expect(getPiExtensionSettings(createLocalSettingsManager(root, root))).toEqual({
      user: false,
      project: false,
      llamaCpp: false,
    });
    expect(getPiExtensionSettings(settingsWith({ piExtensions: { llamaCpp: true } }))).toEqual({
      user: false,
      project: false,
      llamaCpp: true,
    });
    expect(() => getPiExtensionSettings(settingsWith({ piExtensions: { llamaCpp: 'true' } })))
      .toThrow('piExtensions.llamaCpp must be a boolean');
  });

  it('defaults code mode off and validates the native-shaped configuration', () => {
    for (const settings of [{}, { codemode: {} }, { codemode: { inlineBudget: 0 } }]) {
      expect(getLocalCodemodeMode(settingsWith(settings))).toBe('off');
    }
    for (const mode of ['off', 'on', 'only'] as const) {
      expect(getLocalCodemodeMode(settingsWith({ codemode: { mode } }))).toBe(mode);
    }
    for (const codemode of [null, [], 'on', true]) {
      expect(() => getLocalCodemodeMode(settingsWith({ codemode }))).toThrow('codemode must be an object');
    }
    for (const mode of [null, true, 'invalid', 'ON']) {
      expect(() => getLocalCodemodeMode(settingsWith({ codemode: { mode } })))
        .toThrow('codemode.mode must be "off", "on", or "only"');
    }
  });

  it('persists code mode without overwriting native budgets or unrelated settings', async () => {
    const root = await temporaryDirectory();
    const agentDir = join(root, '.felan');
    await mkdir(agentDir);
    const path = join(agentDir, 'settings.json');
    await writeFile(path, JSON.stringify({ codemode: { inlineBudget: 128 }, defaultModel: 'test-model' }));
    await setLocalCodemodeMode(agentDir, 'only');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      codemode: { inlineBudget: 128, mode: 'only' }, defaultModel: 'test-model',
    });
    expect(getLocalCodemodeMode(createLocalSettingsManager(root, agentDir))).toBe('only');
    await setLocalCodemodeMode(agentDir, 'off');
    expect(getLocalCodemodeMode(createLocalSettingsManager(root, agentDir))).toBe('off');
    await writeFile(path, JSON.stringify({ codemode: 'on' }));
    await expect(setLocalCodemodeMode(agentDir, 'on')).rejects.toThrow('codemode must be an object');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ codemode: 'on' });
  });

  it('defaults dynamic thinking on and accepts an explicit disable switch', async () => {
    const root = await temporaryDirectory();
    const agentDir = join(root, '.felan');
    await mkdir(agentDir, { recursive: true });
    const path = join(agentDir, 'settings.json');
    const read = () => getDynamicThinkingEnabled(createLocalSettingsManager(root, agentDir));

    expect(read()).toBe(true);
    await writeFile(path, JSON.stringify({ felanThinking: { dynamic: false } }));
    expect(read()).toBe(false);
    await writeFile(path, JSON.stringify({ felanThinking: { dynamic: true } }));
    expect(read()).toBe(true);
    await writeFile(path, JSON.stringify({ felanThinking: { dynamic: 'false' } }));
    expect(read).toThrow('felanThinking.dynamic must be a boolean');
  });

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
      cacheWarming: 'streaming',
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
    expect(settings.getCacheWarmingMode()).toBe('streaming');
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

    await settings.reload();

    settings.setProjectTrusted(false);
    expect(settings.isProjectTrusted()).toBe(true);
    expect(settings.getDefaultModel()).toBe('test-model');
    expect(settings.getPackages()).toEqual([]);
    expect(settings.getEnableInstallTelemetry()).toBe(false);
    expect(settings.getLastChangelogVersion()).toBe(PI_VERSION);
    expect(settings.getGlobalSettings().packages).toEqual([]);
  });

  it('preserves explicitly configured editor padding', async () => {
    const root = await temporaryDirectory();
    const agentDir = join(root, '.felan');
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ editorPaddingX: 0 }));

    const settings = createLocalSettingsManager(root, agentDir);

    expect(settings.getEditorPaddingX()).toBe(0);
  });

  it('turns off Pi cache warming only when it is not configured', async () => {
    const root = await temporaryDirectory();
    const agentDir = join(root, '.felan');
    await mkdir(agentDir, { recursive: true });
    const settings = createLocalSettingsManager(root, agentDir);

    expect(settings.getCacheWarmingMode()).toBe('off');
  });

  it('warns and defaults removed caveman extension configuration to concise', () => {
    const resolved = resolveExtensionConfigSettings({
      extensionConfig: { outputStyle: { style: 'caveman' } },
    }, [OUTPUT_STYLE_CONFIG]);
    const outputStyle = resolved.configs.get('outputStyle');

    expect(outputStyle).toEqual({ style: 'concise', instructions: '', instructionsFile: '' });
    expect(resolved.warnings).toEqual([
      'settings.json.extensionConfig.outputStyle.style must be one of: concise, explanatory, custom; using the default value.',
    ]);
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
      mergeDaemonGlobalSettings(agentDir, { extensions: [], builtinExtensions: { markitdown: false } }, () => {}),
      setDependencyOnboardingDecision(agentDir, {
        extension: 'rtkOptimizer',
        revision: 1,
        enabled: true,
      }),
    ]);

    const settings = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
    expect(settings).toMatchObject({
      defaultProvider: 'anthropic',
      builtinExtensions: { markitdown: false },
      felanTui: {
        toolDisplay: 'full',
        onboarding: { schemaVersion: 1, extensions: { rtkOptimizer: 1 } },
      },
    });
    expect(isBuiltinExtensionEnabled(settings, 'markitdown')).toBe(false);
    expect(isDependencyOnboardingComplete(settings, 'rtkOptimizer', 1)).toBe(true);
    expect(isDependencyOnboardingComplete(settings, 'rtkOptimizer', 2)).toBe(false);
    const manager = createLocalSettingsManager(root, agentDir);
    expect(isDependencyOnboardingComplete(getFelanSettings(manager), 'rtkOptimizer', 1)).toBe(true);
    await setDependencyOnboardingDecision(agentDir, {
      extension: 'rtkOptimizer',
      revision: 2,
      enabled: false,
    });
    const cleared = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
    expect(cleared.felanTui).toEqual({
      toolDisplay: 'full',
      onboarding: { schemaVersion: 1, extensions: { rtkOptimizer: 2 } },
    });
    expect(cleared.builtinExtensions.rtkOptimizer).toBe(false);
  });

  it('treats legacy, malformed, and mismatched onboarding records as incomplete', () => {
    expect(isDependencyOnboardingComplete({ felanTui: { dependencyOnboarding: { rtk: 'continue' } } }, 'rtkOptimizer', 1)).toBe(false);
    expect(isDependencyOnboardingComplete({ felanTui: { onboarding: { schemaVersion: 2, extensions: { rtkOptimizer: 1 } } } }, 'rtkOptimizer', 1)).toBe(false);
    expect(isDependencyOnboardingComplete({ felanTui: { onboarding: { schemaVersion: 1, extensions: { rtkOptimizer: '1' } } } }, 'rtkOptimizer', 1)).toBe(false);
    expect(isDependencyOnboardingComplete({ felanTui: { onboarding: { schemaVersion: 1, extensions: { rtkOptimizer: 2 } } } }, 'rtkOptimizer', 1)).toBe(false);
  });

  it('persists namespaced extension configuration without replacing unrelated settings', async () => {
    const root = await temporaryDirectory();
    const agentDir = join(root, '.felan');
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ defaultModel: 'model', outputStyle: 'concise' }));

    const config = defineExtensionConfig({
      id: 'prewalk',
      title: 'Prewalk',
      fields: {
        entryApproval: configField.enum(['ask', 'allow', 'deny'], {
          default: 'ask',
          description: 'Approval policy for model-entered Prewalk',
        }),
      },
    });
    await new DaemonConfiguration({ agentDir, definitions: [config], assertCurrent() {} }).set('global', { extensionConfig: { prewalk: { entryApproval: 'allow' } } });
    const settings = getFelanSettings(createLocalSettingsManager(root, agentDir));
    const resolved = resolveExtensionConfigSettings(settings, [config]);
    expect(resolved.overrides).toEqual([{
      extensionId: 'prewalk',
      values: { entryApproval: 'allow' },
      source: 'settings.json.extensionConfig.prewalk',
    }]);
    expect(resolved.configs.get('prewalk')).toEqual({ entryApproval: 'allow' });
    expect(resolved.warnings).toEqual([]);
  });

  it('warns and uses defaults for invalid persisted extension configuration', () => {
    const config = defineExtensionConfig({
      id: 'prewalk',
      title: 'Prewalk',
      fields: {
        entryApproval: configField.enum(['ask', 'allow', 'deny'], {
          default: 'ask',
          description: 'Approval policy for model-entered Prewalk',
        }),
        restorePlanner: configField.boolean({
          default: true,
          description: 'Restore the planner after implementation',
        }),
      },
    });
    const resolved = resolveExtensionConfigSettings({
      extensionConfig: {
        prewalk: {
          entryApproval: 'always',
          restorePlanner: false,
          removedField: true,
        },
      },
    }, [config]);

    expect(resolved.overrides).toEqual([{
      extensionId: 'prewalk',
      values: { restorePlanner: false },
      source: 'settings.json.extensionConfig.prewalk',
    }]);
    expect(resolved.configs.get('prewalk')).toEqual({
      entryApproval: 'ask',
      restorePlanner: false,
    });
    expect(resolved.warnings).toEqual([
      'settings.json.extensionConfig.prewalk.entryApproval must be one of: ask, allow, deny; using the default value.',
      'settings.json.extensionConfig.prewalk contains unknown field: prewalk.removedField; ignoring it.',
    ]);
  });

});

function settingsWith(settings: Record<string, unknown>): SettingsManager {
  return { getGlobalSettings: () => settings } as unknown as SettingsManager;
}

async function temporaryDirectory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'felan-settings-')));
  temporaryPaths.push(path);
  return path;
}

it('reads released Powerline data-collection options without passing display policy to extensions', async () => {
  const { POWERLINE_CONFIG } = await import('@felan-ai/ext-powerline');
  const legacy = { extensionConfig: { powerline: { periodDays: 30, style: 'capsule', lines: [{ segments: {
    git: { enabled: true, showWorkingTree: false, showStashCount: true }, savings: { enabled: true, periodDays: 14 }, subscription: { enabled: true, maxWindows: 2 },
  } }] } } };
  const original = structuredClone(legacy);
  const resolved = resolveExtensionConfigSettings(legacy, [POWERLINE_CONFIG]);
  expect(resolved.configs.get('powerline')).toEqual({ showWorkingTree: false, showStashCount: true, periodDays: 30, maxWindows: 2 });
  expect(legacy).toEqual(original);
  expect(resolved.warnings).toEqual([]);
});

it.each([undefined, false, true])('uses the same legacy Powerline mapping for execution and config.get (working tree %s)', async showWorkingTree => {
  const { POWERLINE_CONFIG } = await import('@felan-ai/ext-powerline');
  const root = await temporaryDirectory();
  const settings = { extensionConfig: { powerline: { style: 'capsule', charset: 'unicode', autoWrap: false, padding: 3,
    lines: [{ segments: { git: { enabled: true, ...(showWorkingTree === undefined ? {} : { showWorkingTree }), showStashCount: true },
      savings: { enabled: true, periodDays: 14 }, subscription: { enabled: true, maxWindows: 2 } } }] } } };
  await writeFile(join(root, 'settings.json'), JSON.stringify(settings));
  const runtime = resolveExtensionConfigSettings(settings, [POWERLINE_CONFIG]);
  expect(runtime.warnings).toEqual([]);
  expect(runtime.configs.get('powerline')).toEqual({ showWorkingTree: showWorkingTree ?? false, showStashCount: true, periodDays: 14, maxWindows: 2 });
  const provider = new DaemonConfiguration({ agentDir: root, definitions: [POWERLINE_CONFIG], assertCurrent() {} });
  expect((await provider.get('global')).values.extensionConfig?.powerline).toEqual(runtime.configs.get('powerline'));
});
