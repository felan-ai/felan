import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SettingsManager } from '@felan-ai/agent-core';
import { VERSION as PI_VERSION } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLocalSettingsManager,
  getFelanSettings,
  getLocalToolDisplayMode,
} from '../src/settings.js';

const temporaryPaths: string[] = [];

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
      felanSubagents: { concurrency: 2 },
      felanTui: { toolDisplay: 'full' },
    });
    expect(getLocalToolDisplayMode(settings)).toBe('full');

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
});

function settingsWith(settings: Record<string, unknown>): SettingsManager {
  return { getGlobalSettings: () => settings } as unknown as SettingsManager;
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-tui-settings-'));
  temporaryPaths.push(path);
  return path;
}
