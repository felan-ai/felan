import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { VERSION as PI_VERSION } from '@earendil-works/pi-coding-agent';
import {
  SettingsManager,
  parseModelReference,
  resolveExtensionConfigs,
  validateExtensionConfigValue,
  type ExtensionConfigDefinition,
  type ExtensionConfigOverride,
  type ExtensionConfigValue,
} from '@felan-ai/agent-core';
import {
  parseOutputStyle,
  type OutputStyle,
} from '@felan-ai/ext-output-style';
import {
  builtinExtensionPackages,
  type BuiltinExtensionName,
  type BuiltinExtensionSettings,
} from './extension-catalog.js';
import { BROWSER_AUTHORIZATION_POLICIES, type BrowserAuthorizationPolicy } from '@felan-ai/ext-browser';
import type { LocalSubagentSettings } from './subagents/host.js';
import { withLocalFileLock } from './lock.js';
import { LIMITS, ThinkingSchema, TuiPreferencesUpdateSchema, assertJson, parseSchema, type TuiPreferencesUpdate } from '@felan-ai/session-protocol';

export interface FelanSettings {
  readonly codemode?: { readonly mode?: LocalCodemodeMode; readonly inlineBudget?: number };
  readonly builtinExtensions?: BuiltinExtensionSettings;
  readonly outputStyle?: OutputStyle;
  readonly felanSubagents?: LocalSubagentSettings;
  readonly felanThinking?: { readonly dynamic?: boolean };
  readonly felanClassifier?: { readonly model?: string };
  readonly felanTui?: FelanTuiSettings;
  readonly piExtensions?: PiExtensionSettings;
  readonly extensionConfig?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export const LOCAL_CODEMODE_MODES = ['off', 'on', 'only'] as const;
export type LocalCodemodeMode = typeof LOCAL_CODEMODE_MODES[number];

export interface PiExtensionSettings {
  readonly user?: boolean;
  readonly project?: boolean;
  readonly llamaCpp?: boolean;
}

export interface ResolvedPiExtensionSettings {
  readonly user: boolean;
  readonly project: boolean;
  readonly llamaCpp: boolean;
}

export interface ResolvedExtensionConfigSettings {
  readonly overrides: readonly ExtensionConfigOverride[];
  readonly configs: ReadonlyMap<string, Readonly<Record<string, ExtensionConfigValue>>>;
  readonly warnings: readonly string[];
}

export function resolveExtensionConfigSettings(
  settings: FelanSettings,
  definitions: readonly ExtensionConfigDefinition[],
): ResolvedExtensionConfigSettings {
  const configuredExtensions: unknown = settings.extensionConfig;
  if (configuredExtensions === undefined) {
    return { overrides: [], configs: resolveExtensionConfigs(definitions), warnings: [] };
  }
  if (!isRecord(configuredExtensions)) {
    return {
      overrides: [],
      configs: resolveExtensionConfigs(definitions),
      warnings: [
        'settings.json.extensionConfig must be an object; using extension defaults.',
      ],
    };
  }

  const overrides: ExtensionConfigOverride[] = [];
  const warnings: string[] = [];
  for (const definition of definitions) {
    const configured = configuredExtensions[definition.id];
    if (configured === undefined) continue;
    const source = `settings.json.extensionConfig.${definition.id}`;
    if (!isRecord(configured)) {
      warnings.push(`${source} must be an object; using extension defaults.`);
      continue;
    }

    const values: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(configured)) {
      if (!Object.hasOwn(definition.fields, field)) {
        warnings.push(`${source} contains unknown field: ${definition.id}.${field}; ignoring it.`);
        continue;
      }
      try {
        values[field] = validateExtensionConfigValue(definition, field, value, `${source}.${field}`);
      } catch (error) {
        warnings.push(`${errorMessage(error)}; using the default value.`);
      }
    }
    if (Object.keys(values).length > 0) {
      overrides.push({ extensionId: definition.id, values, source });
    }
  }
  return { overrides, configs: resolveExtensionConfigs(definitions, overrides), warnings };
}

export async function setExtensionConfigValue(
  agentDir: string,
  extensionId: string,
  field: string,
  value: unknown,
): Promise<void> {
  await setExtensionConfigValues(agentDir, extensionId, { [field]: value });
}

export async function setExtensionConfigValues(
  agentDir: string,
  extensionId: string,
  values: Readonly<Record<string, unknown>>,
): Promise<void> {
  await updateGlobalFelanSettings(agentDir, (settings) => {
    const current = settings.extensionConfig;
    if (current !== undefined && !isRecord(current)) throw new Error('extensionConfig must be an object');
    const extensionConfig = { ...(current ?? {}) };
    const existing = extensionConfig[extensionId];
    if (existing !== undefined && !isRecord(existing)) throw new Error(`extensionConfig.${extensionId} must be an object`);
    extensionConfig[extensionId] = { ...(existing ?? {}), ...values };
    settings.extensionConfig = extensionConfig;
  });
}

export interface FelanTuiSettings {
  readonly toolDisplay?: LocalToolDisplayMode;
  readonly onboarding?: FelanOnboardingSettings;
}

export type LocalToolDisplayMode = 'grouped' | 'full';

export const FELAN_ONBOARDING_SCHEMA_VERSION = 1;

export interface FelanOnboardingSettings {
  readonly schemaVersion: number;
  readonly extensions: Readonly<Record<string, number>>;
}

export interface DependencyOnboardingDecision {
  readonly extension: BuiltinExtensionName;
  readonly revision: number;
  readonly enabled: boolean;
}

export function getLocalOutputStyle(
  settingsManager: SettingsManager,
  resolvedConfig?: Readonly<Record<string, ExtensionConfigValue>> | null,
): OutputStyle {
  const rawSettings = settingsManager.getGlobalSettings() as Record<string, unknown>;
  if (resolvedConfig !== undefined) {
    if (resolvedConfig?.style !== undefined) return parseOutputStyle(resolvedConfig.style);
  } else {
    const extensionConfig = rawSettings.extensionConfig;
    if (isRecord(extensionConfig) && isRecord(extensionConfig.outputStyle) && extensionConfig.outputStyle.style !== undefined) {
      return parseOutputStyle(extensionConfig.outputStyle.style);
    }
  }
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
  const getEditorPaddingX = settingsManager.getEditorPaddingX.bind(settingsManager);
  const getGlobalSettings = settingsManager.getGlobalSettings.bind(settingsManager);
  const getProjectSettings = settingsManager.getProjectSettings.bind(settingsManager);
  const getCacheWarmingMode = settingsManager.getCacheWarmingMode.bind(settingsManager);

  settingsManager.applyOverrides(runtimeOverrides);
  settingsManager.getCacheWarmingMode = () => {
    const configured = (getGlobalSettings() as Record<string, unknown>).cacheWarming;
    return configured === undefined ? 'off' : getCacheWarmingMode();
  };
  settingsManager.reload = async () => {
    await reload();
    settingsManager.applyOverrides(runtimeOverrides);
  };
  settingsManager.getEditorPaddingX = () => (
    getGlobalSettings().editorPaddingX === undefined ? 1 : getEditorPaddingX()
  );
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

export function getLocalCodemodeMode(settingsManager: SettingsManager): LocalCodemodeMode {
  const raw = (settingsManager.getGlobalSettings() as Record<string, unknown>).codemode;
  if (raw === undefined) return 'off';
  if (!isRecord(raw)) throw new Error('codemode must be an object');
  return parseLocalCodemodeMode(raw.mode);
}

function parseLocalCodemodeMode(value: unknown): LocalCodemodeMode {
  if (value === undefined) return 'off';
  if (value === 'off' || value === 'on' || value === 'only') return value;
  throw new Error('codemode.mode must be "off", "on", or "only"');
}

export async function setLocalCodemodeMode(agentDir: string, mode: LocalCodemodeMode): Promise<void> {
  const validated = parseLocalCodemodeMode(mode);
  await updateGlobalFelanSettings(agentDir, (settings) => {
    const current = settings.codemode;
    if (current !== undefined && !isRecord(current)) throw new Error('codemode must be an object');
    settings.codemode = { ...(current ?? {}), mode: validated };
  });
}

export function getClassifierModelSetting(settingsManager: SettingsManager): string {
  const raw = (settingsManager.getGlobalSettings() as Record<string, unknown>).felanClassifier;
  if (raw === undefined) return 'auto';
  if (!isRecord(raw)) throw new Error('felanClassifier must be an object');
  return parseClassifierModelSetting(raw.model);
}

export function parseClassifierModelSetting(value: unknown): string {
  if (value === undefined) return 'auto';
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/u.test(value)) {
    throw new Error('felanClassifier.model must be "auto" or an exact provider/model-id');
  }
  const normalized = value.trim();
  if (normalized === 'auto') return normalized;
  const reference = parseModelReference(normalized);
  if (!reference) throw new Error('felanClassifier.model must be "auto" or an exact provider/model-id');
  return `${reference.provider}/${reference.id}`;
}

export async function setClassifierModelSetting(agentDir: string, model: string): Promise<void> {
  const normalized = parseClassifierModelSetting(model);
  await updateGlobalFelanSettings(agentDir, settings => {
    const current = settings.felanClassifier;
    if (current !== undefined && !isRecord(current)) throw new Error('felanClassifier must be an object');
    settings.felanClassifier = { ...(current ?? {}), model: normalized };
  });
}

export function getDynamicThinkingEnabled(settingsManager: SettingsManager): boolean {
  const raw = (settingsManager.getGlobalSettings() as Record<string, unknown>).felanThinking;
  if (raw === undefined) return true;
  if (!isRecord(raw)) throw new Error('felanThinking must be an object');
  if (raw.dynamic === undefined) return true;
  if (typeof raw.dynamic !== 'boolean') throw new Error('felanThinking.dynamic must be a boolean');
  return raw.dynamic;
}

export function getBrowserAuthorizationPolicy(settingsManager: SettingsManager): BrowserAuthorizationPolicy {
  const configured = getFelanSettings(settingsManager).extensionConfig?.browser?.authorizationPolicy;
  return BROWSER_AUTHORIZATION_POLICIES.includes(configured as BrowserAuthorizationPolicy)
    ? configured as BrowserAuthorizationPolicy
    : 'ask';
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

export function getPiExtensionSettings(settingsManager: SettingsManager): ResolvedPiExtensionSettings {
  const rawSettings = settingsManager.getGlobalSettings() as Record<string, unknown>;
  return parsePiExtensionSettings(rawSettings.piExtensions);
}

export function parsePiExtensionSettings(raw: unknown): ResolvedPiExtensionSettings {
  if (raw === undefined) return { user: false, project: false, llamaCpp: false };
  if (!isRecord(raw)) throw new Error('piExtensions must be an object');
  return {
    user: optionalBooleanSetting(raw.user, 'piExtensions.user'),
    project: optionalBooleanSetting(raw.project, 'piExtensions.project'),
    llamaCpp: optionalBooleanSetting(raw.llamaCpp, 'piExtensions.llamaCpp'),
  };
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

export async function setDependencyOnboardingDecision(
  agentDir: string,
  decision: DependencyOnboardingDecision,
): Promise<void> {
  if (!Number.isSafeInteger(decision.revision) || decision.revision < 1) {
    throw new Error('Dependency onboarding revision must be a positive safe integer');
  }
  await updateGlobalFelanSettings(agentDir, (settings) => {
    const rawBuiltins = settings.builtinExtensions;
    if (rawBuiltins !== undefined && !isRecord(rawBuiltins)) {
      throw new Error('builtinExtensions must be an object');
    }
    const rawTui = settings.felanTui;
    if (rawTui !== undefined && !isRecord(rawTui)) throw new Error('felanTui must be an object');
    const tui = { ...(rawTui ?? {}) };
    const extensions = currentOnboardingExtensions(tui.onboarding);
    extensions[decision.extension] = decision.revision;

    settings.builtinExtensions = {
      ...(rawBuiltins ?? {}),
      [decision.extension]: decision.enabled,
    };
    tui.onboarding = {
      schemaVersion: FELAN_ONBOARDING_SCHEMA_VERSION,
      extensions,
    };
    delete tui.dependencyOnboarding;
    settings.felanTui = tui;
  });
}

export function isBuiltinExtensionEnabled(settings: FelanSettings, name: BuiltinExtensionName): boolean {
  return settings.builtinExtensions?.[name] !== false;
}

export function isDependencyOnboardingComplete(
  settings: FelanSettings,
  extension: BuiltinExtensionName,
  revision: number,
): boolean {
  const rawTui: unknown = settings.felanTui;
  if (!isRecord(rawTui)) return false;
  const onboarding = rawTui.onboarding;
  if (!isCurrentOnboardingSettings(onboarding)) return false;
  return onboarding.extensions[extension] === revision;
}

type MutableSettings = Record<string, unknown> & {
  builtinExtensions?: Record<string, unknown>;
  felanTui?: Record<string, unknown>;
  extensionConfig?: Record<string, unknown>;
};

export interface DaemonGlobalSettingsUpdate {
  readonly extensions: readonly { definition: ExtensionConfigDefinition; field: string; value: unknown }[];
  readonly scopedModels?: readonly string[];
  readonly defaultModel?: string;
  readonly defaultThinking?: string;
  readonly preferences?: TuiPreferencesUpdate;
  readonly dependencyDecisions?: readonly DependencyOnboardingDecision[];
}

const MAX_DAEMON_SETTINGS_BYTES = 1024 * 1024;

export async function mergeDaemonGlobalSettings(
  agentDir: string, update: DaemonGlobalSettingsUpdate, assertCurrent: () => void,
): Promise<void> {
  const extensions = update.extensions.map(({ definition, field, value }) => {
    assertJson(value, LIMITS.structuredBytes);
    const config = definition.fields[field];
    if (!config || config.sensitive || config.cliName === false) throw new Error('Configuration field is unavailable.');
    return { id: definition.id, field, value: validateExtensionConfigValue(definition, field, value, 'daemon configuration') };
  });
  const defaults: Record<string, unknown> = {};
  if (update.scopedModels !== undefined) {
    assertJson(update.scopedModels, LIMITS.structuredBytes);
    if (!Array.isArray(update.scopedModels) || update.scopedModels.length > LIMITS.catalogEntries
      || update.scopedModels.some(value => typeof value !== 'string' || !value || Buffer.byteLength(value) > LIMITS.idBytes || /[\x00-\x1f\x7f]/u.test(value))) throw new Error('Invalid configured model scope.');
    defaults.enabledModels = [...update.scopedModels];
  }
  if (update.defaultModel !== undefined) {
    if (typeof update.defaultModel !== 'string' || Buffer.byteLength(update.defaultModel) > LIMITS.idBytes || /[\x00-\x1f\x7f]/u.test(update.defaultModel)) throw new Error('Invalid configured default model.');
    const model = parseModelReference(update.defaultModel);
    if (!model) throw new Error('Default model must be an exact provider/model-id.');
    defaults.defaultProvider = model.provider; defaults.defaultModel = model.id;
  }
  if (update.defaultThinking !== undefined) defaults.defaultThinkingLevel = parseSchema(ThinkingSchema, update.defaultThinking);
  const preferences = update.preferences === undefined ? undefined : parseSchema(TuiPreferencesUpdateSchema, update.preferences);
  const decisions = update.dependencyDecisions ?? [];
  if (decisions.length > 16 || decisions.some(value => !Object.hasOwn(builtinExtensionPackages, value.extension)
    || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.enabled !== 'boolean')) throw new Error('Invalid dependency decisions.');
  if (!extensions.length && !Object.keys(defaults).length && !preferences && !decisions.length) throw new Error('Empty configuration update.');
  await accessDaemonGlobalSettings(agentDir, assertCurrent, settings => {
    if (extensions.length) {
      const current = settings.extensionConfig;
      if (current !== undefined && !isRecord(current)) throw new Error('extensionConfig must be an object');
      const next = { ...current };
      for (const { id, field, value } of extensions) {
        const existing = next[id];
        if (existing !== undefined && !isRecord(existing)) throw new Error(`extensionConfig.${id} must be an object`);
        next[id] = { ...existing, [field]: value };
      }
      settings.extensionConfig = next;
    }
    if (preferences) {
      if (preferences.hideThinking !== undefined) settings.hideThinkingBlock = preferences.hideThinking;
      if (preferences.outputPad !== undefined) settings.outputPad = preferences.outputPad;
      if (preferences.toolDisplay !== undefined || preferences.keybindings !== undefined) {
        if (settings.felanTui !== undefined && !isRecord(settings.felanTui)) throw new Error('felanTui must be an object');
        settings.felanTui = { ...settings.felanTui,
          ...(preferences.toolDisplay === undefined ? {} : { toolDisplay: preferences.toolDisplay }),
          ...(preferences.keybindings === undefined ? {} : { keybindings: preferences.keybindings }) };
      }
      if (preferences.showImages !== undefined || preferences.imageWidthCells !== undefined) {
        if (settings.terminal !== undefined && !isRecord(settings.terminal)) throw new Error('terminal must be an object');
        settings.terminal = { ...(settings.terminal as Record<string, unknown> | undefined),
          ...(preferences.showImages === undefined ? {} : { showImages: preferences.showImages }),
          ...(preferences.imageWidthCells === undefined ? {} : { imageWidthCells: preferences.imageWidthCells }) };
      }
    }
    if (decisions.length) {
      if (settings.felanTui !== undefined && !isRecord(settings.felanTui)) throw new Error('felanTui must be an object');
      if (settings.builtinExtensions !== undefined && !isRecord(settings.builtinExtensions)) throw new Error('builtinExtensions must be an object');
      const tui = { ...settings.felanTui }; const versions = currentOnboardingExtensions(tui.onboarding);
      const builtins = { ...settings.builtinExtensions };
      for (const decision of decisions) { versions[decision.extension] = decision.revision; builtins[decision.extension] = decision.enabled; }
      tui.onboarding = { schemaVersion: FELAN_ONBOARDING_SCHEMA_VERSION, extensions: versions }; delete tui.dependencyOnboarding;
      settings.felanTui = tui; settings.builtinExtensions = builtins;
    }
    Object.assign(settings, defaults);
  });
}

export async function readDaemonGlobalSettings(agentDir: string, assertCurrent: () => void): Promise<Readonly<Record<string, unknown>>> {
  return accessDaemonGlobalSettings(agentDir, assertCurrent);
}

async function accessDaemonGlobalSettings(
  agentDir: string, assertCurrent: () => void, merge?: (settings: MutableSettings) => void,
): Promise<MutableSettings> {
  assertCurrent();
  if (resolve(agentDir) !== agentDir || await realpath(agentDir) !== agentDir) throw new Error('Daemon settings directory must be canonical.');
  const directory = await lstat(agentDir);
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o022)) throw new Error('Unsafe daemon settings directory.');
  const path = join(agentDir, 'settings.json');
  return withLocalFileLock(path, { realpath: false, retries: { retries: 10, minTimeout: 20, maxTimeout: 50 } }, async lock => {
    const check = async () => {
      assertCurrent(); lock.throwIfCompromised();
      if (!(await lock.isCurrent())) throw new Error('Daemon settings lock was replaced.');
      const current = await lstat(agentDir);
      if (!sameFile(current, directory) || current.uid !== directory.uid || (current.mode & 0o022) || await realpath(agentDir) !== agentDir) throw new Error('Daemon settings directory was replaced.');
      assertCurrent(); lock.throwIfCompromised();
    };
    await check();
    let original: Stats | undefined; let settings: MutableSettings = {};
    let file;
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      original = await file.stat();
      if (!original.isFile() || original.nlink !== 1 || original.uid !== directory.uid) throw new Error('Unsafe daemon settings file.');
      const data = Buffer.alloc(MAX_DAEMON_SETTINGS_BYTES + 1); let length = 0;
      while (length < data.byteLength) {
        const read = await file.read(data, length, data.byteLength - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > MAX_DAEMON_SETTINGS_BYTES) throw new Error('Daemon settings byte limit exceeded.');
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, length)));
      if (!isRecord(parsed)) throw new Error('settings.json must contain an object');
      settings = parsed;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    } finally { await file?.close(); }
    await check();
    if (!merge) return settings;
    merge(settings);
    const data = `${JSON.stringify(settings, null, 2)}\n`;
    if (Buffer.byteLength(data) > MAX_DAEMON_SETTINGS_BYTES) throw new Error('Daemon settings byte limit exceeded.');
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    let temporary: Stats | undefined;
    try {
      const target = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { temporary = await target.stat(); await target.writeFile(data); await target.sync(); } finally { await target.close(); }
      await check();
      let current: Stats | undefined;
      try { current = await lstat(path); } catch (error) { if (!isMissingFile(error)) throw error; }
      if (original ? !current || !sameFile(original, current) || original.size !== current.size || original.mtimeMs !== current.mtimeMs : current !== undefined) throw new Error('Daemon settings file changed during update.');
      if (!sameFile(await lstat(temporaryPath), temporary)) throw new Error('Daemon settings temporary file was replaced.');
      assertCurrent(); lock.throwIfCompromised();
      await rename(temporaryPath, path);
      await check();
      if (!sameFile(await lstat(path), temporary)) throw new Error('Daemon settings commit was replaced.');
      const handle = await open(agentDir, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
      await check();
      return settings;
    } finally {
      if (temporary) {
        const current = await lstat(temporaryPath).catch(() => undefined);
        if (current && sameFile(current, temporary)) await rm(temporaryPath, { force: true });
      }
    }
  });
}

function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }

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

function currentOnboardingExtensions(value: unknown): Record<string, unknown> {
  return isCurrentOnboardingSettings(value) ? { ...value.extensions } : {};
}

function isCurrentOnboardingSettings(value: unknown): value is {
  readonly schemaVersion: typeof FELAN_ONBOARDING_SCHEMA_VERSION;
  readonly extensions: Readonly<Record<string, unknown>>;
} {
  return isRecord(value)
    && value.schemaVersion === FELAN_ONBOARDING_SCHEMA_VERSION
    && isRecord(value.extensions);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT';
}

function isAlreadyExistsFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'EEXIST';
}

function optionalBooleanSetting(value: unknown, path: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
