import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VERSION as PI_VERSION } from '@earendil-works/pi-coding-agent';
import { SettingsManager } from '@felan-ai/agent-core';
import {
  parseOutputStyle,
  type OutputStyle,
} from '@felan-ai/ext-output-style';
import {
  builtinExtensionPackages,
  type BuiltinExtensionName,
  type BuiltinExtensionSettings,
} from './extensions.js';
import type { LocalSubagentSettings } from './subagents/host.js';
import { withLocalFileLock } from './lock.js';

export interface FelanSettings {
  readonly builtinExtensions?: BuiltinExtensionSettings;
  readonly outputStyle?: OutputStyle;
  readonly felanSubagents?: LocalSubagentSettings;
  readonly felanTui?: FelanTuiSettings;
}

export interface FelanTuiSettings {
  readonly toolDisplay?: LocalToolDisplayMode;
  readonly memoryProcessing?: boolean;
  readonly dependencyOnboarding?: Readonly<Record<string, LocalDependencyOnboardingChoice>>;
}

export type LocalToolDisplayMode = 'grouped' | 'full';
export type LocalDependencyOnboardingChoice = 'continue';

export function getLocalOutputStyle(settingsManager: SettingsManager): OutputStyle {
  const rawSettings = settingsManager.getGlobalSettings() as Record<string, unknown>;
  return parseOutputStyle(rawSettings.outputStyle);
}

export function createLocalSettingsManager(cwd: string, agentDir: string): SettingsManager {
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  // Felan's fixed resource policy makes Pi project trust unnecessary.
  settingsManager.isProjectTrusted = () => true;
  settingsManager.setProjectTrusted = () => {};
  const filteredResources = {
    packages: [],
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  };
  const runtimeOverrides = {
    ...filteredResources,
    enableInstallTelemetry: false,
    lastChangelogVersion: PI_VERSION,
  };
  const reload = settingsManager.reload.bind(settingsManager);
  const getGlobalSettings = settingsManager.getGlobalSettings.bind(settingsManager);
  const getProjectSettings = settingsManager.getProjectSettings.bind(settingsManager);

  settingsManager.applyOverrides(runtimeOverrides);
  settingsManager.reload = async () => {
    await reload();
    settingsManager.applyOverrides(runtimeOverrides);
  };
  settingsManager.getGlobalSettings = () => ({
    ...getGlobalSettings(),
    ...filteredResources,
  });
  settingsManager.getProjectSettings = () => ({
    ...getProjectSettings(),
    ...filteredResources,
  });
  return settingsManager;
}

export function getFelanSettings(settingsManager: SettingsManager): FelanSettings {
  return settingsManager.getGlobalSettings() as FelanSettings;
}

export function getLocalToolDisplayMode(settingsManager: SettingsManager): LocalToolDisplayMode {
  const rawSettings = settingsManager.getGlobalSettings() as Record<string, unknown>;
  const rawTui = rawSettings.felanTui;
  if (rawTui === undefined) return 'grouped';
  if (!isRecord(rawTui)) throw new Error('felanTui must be an object');

  const mode = rawTui.toolDisplay;
  if (mode === undefined) return 'grouped';
  if (mode === 'grouped' || mode === 'full') return mode;
  throw new Error('felanTui.toolDisplay must be "grouped" or "full"');
}

export function getLocalMemoryProcessingEnabled(settingsManager: SettingsManager): boolean {
  const rawSettings = settingsManager.getGlobalSettings() as Record<string, unknown>;
  const rawTui = rawSettings.felanTui;
  if (rawTui === undefined) return true;
  if (!isRecord(rawTui)) throw new Error('felanTui must be an object');
  const value = rawTui.memoryProcessing;
  if (value === undefined) return true;
  if (typeof value !== 'boolean') throw new Error('felanTui.memoryProcessing must be a boolean');
  return value;
}

export async function setBuiltinExtensionEnabled(
  agentDir: string,
  name: BuiltinExtensionName,
  enabled: boolean,
): Promise<void> {
  await updateGlobalFelanSettings(agentDir, (settings) => {
    const raw = settings.builtinExtensions;
    if (raw !== undefined && !isRecord(raw)) throw new Error('builtinExtensions must be an object');
    settings.builtinExtensions = { ...(raw ?? {}), [name]: enabled };
  });
}

export async function setLocalMemoryProcessingEnabled(
  agentDir: string,
  enabled: boolean,
): Promise<void> {
  await updateGlobalFelanSettings(agentDir, (settings) => {
    const rawTui = settings.felanTui;
    if (rawTui !== undefined && !isRecord(rawTui)) throw new Error('felanTui must be an object');
    settings.felanTui = { ...(rawTui ?? {}), memoryProcessing: enabled };
  });
}

export async function setDependencyOnboardingChoice(
  agentDir: string,
  dependencyId: string,
  choice: LocalDependencyOnboardingChoice | undefined,
): Promise<void> {
  await updateGlobalFelanSettings(agentDir, (settings) => {
    const rawTui = settings.felanTui;
    if (rawTui !== undefined && !isRecord(rawTui)) throw new Error('felanTui must be an object');
    const tui = { ...(rawTui ?? {}) };
    const rawChoices = tui.dependencyOnboarding;
    if (rawChoices !== undefined && !isRecord(rawChoices)) {
      throw new Error('felanTui.dependencyOnboarding must be an object');
    }
    const choices = { ...(rawChoices ?? {}) };
    if (choice === undefined) delete choices[dependencyId];
    else choices[dependencyId] = choice;
    if (Object.keys(choices).length === 0) delete tui.dependencyOnboarding;
    else tui.dependencyOnboarding = choices;
    settings.felanTui = tui;
  });
}

export function isBuiltinExtensionEnabled(settings: FelanSettings, name: BuiltinExtensionName): boolean {
  return settings.builtinExtensions?.[name] !== false;
}

export function getDependencyOnboardingChoice(
  settings: FelanSettings,
  dependencyId: string,
): LocalDependencyOnboardingChoice | undefined {
  const value = settings.felanTui?.dependencyOnboarding?.[dependencyId];
  return value === 'continue' ? value : undefined;
}

type MutableSettings = Record<string, unknown> & {
  builtinExtensions?: Record<string, unknown>;
  felanTui?: Record<string, unknown>;
};

async function updateGlobalFelanSettings(
  agentDir: string,
  update: (settings: MutableSettings) => void,
): Promise<void> {
  const path = join(agentDir, 'settings.json');
  await mkdir(agentDir, { recursive: true });
  try {
    await writeFile(path, '{}\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!isAlreadyExistsFile(error)) throw error;
  }
  await withLocalFileLock(path, {
    realpath: false,
    retries: { retries: 10, minTimeout: 20, maxTimeout: 50 },
  }, async (lock) => {
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      let settings: MutableSettings;
      try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!isRecord(parsed)) throw new Error('settings.json must contain an object');
        settings = structuredClone(parsed) as MutableSettings;
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        settings = {};
      }

      update(settings);
      validateBuiltinExtensionKeys(settings.builtinExtensions);
      await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      lock.throwIfCompromised();
      await rename(temporaryPath, path);
      lock.throwIfCompromised();
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  });
}

function validateBuiltinExtensionKeys(settings: Record<string, unknown> | undefined): void {
  if (!settings) return;
  for (const [name, enabled] of Object.entries(settings)) {
    if (!Object.hasOwn(builtinExtensionPackages, name)) throw new Error(`Unknown built-in extension: ${name}`);
    if (typeof enabled !== 'boolean') throw new Error(`Built-in extension ${name} must be a boolean`);
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT';
}

function isAlreadyExistsFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'EEXIST';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
