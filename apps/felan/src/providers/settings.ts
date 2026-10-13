import type { OutputStyle } from '@felan-ai/ext-output-style';
import { VERSION as PI_VERSION } from '@earendil-works/pi-coding-agent';
import {
  SettingsManager,
  resolveExtensionConfigs,
  validateExtensionConfigValue,
  type ExtensionConfigDefinition,
  type ExtensionConfigOverride,
  type ExtensionConfigValue,
  type ExtensionConfigWriter,
} from '@felan-ai/agent-core';
import {
  isBuiltinExtensionEnabled,
  isDependencyOnboardingComplete,
  parsePiExtensionSettings,
  parseClassifierModelSetting,
  updateDaemonGlobalSettings,
  type DaemonGlobalSettings,
  type ResolvedPiExtensionSettings,
} from './global-settings.js';
import { validateBuiltinExtensionKeys, type BuiltinExtensionName, type BuiltinExtensionSettings } from './extension-catalog.js';

export type FelanSettings = DaemonGlobalSettings & {
  readonly codemode?: { readonly mode?: LocalCodemodeMode; readonly inlineBudget?: number };
  readonly builtinExtensions?: BuiltinExtensionSettings;
  readonly outputStyle?: OutputStyle;
  readonly felanThinking?: { readonly dynamic?: boolean };
  readonly felanClassifier?: { readonly model?: string };
  readonly felanTui?: FelanTuiSettings;
  readonly piExtensions?: PiExtensionSettings;
  readonly extensionConfig?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
};

export const LOCAL_CODEMODE_MODES = ['off', 'on', 'only'] as const;
export type LocalCodemodeMode = typeof LOCAL_CODEMODE_MODES[number];

export interface PiExtensionSettings {
  readonly user?: boolean;
  readonly project?: boolean;
  readonly llamaCpp?: boolean;
}

export { isBuiltinExtensionEnabled, isDependencyOnboardingComplete, type ResolvedPiExtensionSettings };

export interface ResolvedExtensionConfigSettings {
  readonly overrides: readonly ExtensionConfigOverride[];
  readonly configs: ReadonlyMap<string, Readonly<Record<string, ExtensionConfigValue>>>;
  readonly warnings: readonly string[];
}

export function resolveExtensionConfigSettings(settings: FelanSettings, definitions: readonly ExtensionConfigDefinition[]): ResolvedExtensionConfigSettings {
  const configuredExtensions: unknown = settings.extensionConfig;
  if (configuredExtensions === undefined) return { overrides: [], configs: resolveExtensionConfigs(definitions), warnings: [] };
  if (!isRecord(configuredExtensions)) return { overrides: [], configs: resolveExtensionConfigs(definitions), warnings: ['settings.json.extensionConfig must be an object; using extension defaults.'] };
  const overrides: ExtensionConfigOverride[] = [];
  const warnings: string[] = [];
  for (const definition of definitions) {
    const configured = configuredExtensions[definition.id];
    if (configured === undefined) continue;
    const source = `settings.json.extensionConfig.${definition.id}`;
    if (!isRecord(configured)) { warnings.push(`${source} must be an object; using extension defaults.`); continue; }
    const values: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(configured)) {
      if (!Object.hasOwn(definition.fields, field)) { warnings.push(`${source} contains unknown field: ${definition.id}.${field}; ignoring it.`); continue; }
      try { values[field] = validateExtensionConfigValue(definition, field, value, `${source}.${field}`); }
      catch (error) { warnings.push(`${errorMessage(error)}; using the default value.`); }
    }
    if (Object.keys(values).length > 0) overrides.push({ extensionId: definition.id, values, source });
  }
  return { overrides, configs: resolveExtensionConfigs(definitions, overrides), warnings };
}

export async function setExtensionConfigValue(agentDir: string, extensionId: string, field: string, value: unknown): Promise<void> {
  await setExtensionConfigValues(agentDir, extensionId, { [field]: value });
}

export async function setExtensionConfigValues(agentDir: string, extensionId: string, values: Readonly<Record<string, unknown>>): Promise<void> {
  await updateFelanSettings(agentDir, settings => {
    const current = settings.extensionConfig;
    if (current !== undefined && !isRecord(current)) throw new Error('extensionConfig must be an object');
    const extensionConfig = { ...(current ?? {}) };
    const existing = extensionConfig[extensionId];
    if (existing !== undefined && !isRecord(existing)) throw new Error(`extensionConfig.${extensionId} must be an object`);
    extensionConfig[extensionId] = { ...(existing ?? {}), ...values };
    settings.extensionConfig = extensionConfig;
  });
}

export function createLocalExtensionConfigWriter(options: {
  readonly agentDir: string;
  readonly definitions: ReadonlyMap<string, ExtensionConfigDefinition>;
  readonly overrides: readonly ExtensionConfigOverride[];
  readonly reload?: () => Promise<void>;
}): ExtensionConfigWriter {
  const overridden = new Map<string, Set<string>>();
  for (const override of options.overrides) {
    const fields = overridden.get(override.extensionId) ?? new Set<string>();
    for (const field of Object.keys(override.values)) fields.add(field);
    overridden.set(override.extensionId, fields);
  }
  return async (packageName, patch) => {
    const definition = options.definitions.get(packageName);
    if (!definition) throw new Error('Extension configuration persistence is unavailable for this package.');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)
      || Object.getPrototypeOf(patch) !== Object.prototype && Object.getPrototypeOf(patch) !== null) {
      throw new Error('Extension configuration patch must be a plain object.');
    }
    const values = Object.create(null) as Record<string, ExtensionConfigValue>;
    for (const field of Reflect.ownKeys(patch)) {
      if (typeof field !== 'string' || !Object.hasOwn(definition.fields, field)) throw new Error('Unknown extension configuration field.');
      if (definition.fields[field]!.sensitive) throw new Error('Sensitive configuration cannot be changed through extension UI.');
      if (overridden.get(definition.id)?.has(field)) throw new Error('Session-overridden configuration cannot be persisted.');
      const descriptor = Object.getOwnPropertyDescriptor(patch, field)!;
      if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('Extension configuration fields must be data properties.');
      values[field] = validateExtensionConfigValue(definition, field, descriptor.value, 'extension configuration update');
    }
    if (!Object.keys(values).length) return;
    await setExtensionConfigValues(options.agentDir, definition.id, values);
    await options.reload?.();
  };
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

export function createLocalSettingsManager(cwd: string, agentDir: string): SettingsManager {
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  settingsManager.isProjectTrusted = () => true;
  settingsManager.setProjectTrusted = () => {};
  const filteredResources = { packages: [], extensions: [], skills: [], prompts: [], themes: [] };
  const runtimeOverrides = { ...filteredResources, enableInstallTelemetry: false, lastChangelogVersion: PI_VERSION };
  const reload = settingsManager.reload.bind(settingsManager);
  const getEditorPaddingX = settingsManager.getEditorPaddingX.bind(settingsManager);
  const getGlobalSettings = settingsManager.getGlobalSettings.bind(settingsManager);
  const getProjectSettings = settingsManager.getProjectSettings.bind(settingsManager);
  const getCacheWarmingMode = settingsManager.getCacheWarmingMode.bind(settingsManager);
  settingsManager.applyOverrides(runtimeOverrides);
  settingsManager.getCacheWarmingMode = () => (getGlobalSettings() as Record<string, unknown>).cacheWarming === undefined ? 'off' : getCacheWarmingMode();
  settingsManager.reload = async () => { await reload(); settingsManager.applyOverrides(runtimeOverrides); };
  settingsManager.getEditorPaddingX = () => getGlobalSettings().editorPaddingX === undefined ? 1 : getEditorPaddingX();
  settingsManager.getGlobalSettings = () => ({ ...getGlobalSettings(), ...filteredResources });
  settingsManager.getProjectSettings = () => ({ ...getProjectSettings(), ...filteredResources });
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

export async function setLocalCodemodeMode(agentDir: string, mode: LocalCodemodeMode): Promise<void> {
  const validated = parseLocalCodemodeMode(mode);
  await updateFelanSettings(agentDir, settings => {
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

export function getDynamicThinkingEnabled(settingsManager: SettingsManager): boolean {
  const raw = (settingsManager.getGlobalSettings() as Record<string, unknown>).felanThinking;
  if (raw === undefined) return true;
  if (!isRecord(raw)) throw new Error('felanThinking must be an object');
  if (raw.dynamic === undefined) return true;
  if (typeof raw.dynamic !== 'boolean') throw new Error('felanThinking.dynamic must be a boolean');
  return raw.dynamic;
}

export function getLocalToolDisplayMode(settingsManager: SettingsManager): LocalToolDisplayMode {
  const rawTui = (settingsManager.getGlobalSettings() as Record<string, unknown>).felanTui;
  if (rawTui === undefined) return 'grouped';
  if (!isRecord(rawTui)) throw new Error('felanTui must be an object');
  if (rawTui.toolDisplay === undefined) return 'grouped';
  if (rawTui.toolDisplay === 'grouped' || rawTui.toolDisplay === 'full') return rawTui.toolDisplay;
  throw new Error('felanTui.toolDisplay must be "grouped" or "full"');
}

export function getPiExtensionSettings(settingsManager: SettingsManager): ResolvedPiExtensionSettings {
  return parsePiExtensionSettings((settingsManager.getGlobalSettings() as Record<string, unknown>).piExtensions);
}

export async function setDependencyOnboardingDecision(agentDir: string, decision: DependencyOnboardingDecision): Promise<void> {
  if (!Number.isSafeInteger(decision.revision) || decision.revision < 1) throw new Error('Dependency onboarding revision must be a positive safe integer');
  await updateFelanSettings(agentDir, settings => {
    const rawBuiltins = settings.builtinExtensions;
    if (rawBuiltins !== undefined && !isRecord(rawBuiltins)) throw new Error('builtinExtensions must be an object');
    const rawTui = settings.felanTui;
    if (rawTui !== undefined && !isRecord(rawTui)) throw new Error('felanTui must be an object');
    const tui = { ...(rawTui ?? {}) };
    const extensions = currentOnboardingExtensions(tui.onboarding);
    extensions[decision.extension] = decision.revision;
    settings.builtinExtensions = { ...(rawBuiltins ?? {}), [decision.extension]: decision.enabled };
    tui.onboarding = { schemaVersion: FELAN_ONBOARDING_SCHEMA_VERSION, extensions };
    delete tui.dependencyOnboarding;
    settings.felanTui = tui;
  });
}

async function updateFelanSettings(agentDir: string, update: (settings: Record<string, unknown>) => void): Promise<void> {
  await updateDaemonGlobalSettings(agentDir, () => {}, settings => {
    update(settings);
    validateBuiltinExtensionKeys(settings.builtinExtensions);
  });
}

function parseLocalCodemodeMode(value: unknown): LocalCodemodeMode {
  if (value === undefined) return 'off';
  if (value === 'off' || value === 'on' || value === 'only') return value;
  throw new Error('codemode.mode must be "off", "on", or "only"');
}

function currentOnboardingExtensions(value: unknown): Record<string, unknown> {
  return isCurrentOnboardingSettings(value) ? { ...value.extensions } : {};
}

function isCurrentOnboardingSettings(value: unknown): value is { readonly schemaVersion: typeof FELAN_ONBOARDING_SCHEMA_VERSION; readonly extensions: Readonly<Record<string, unknown>> } {
  return isRecord(value) && value.schemaVersion === FELAN_ONBOARDING_SCHEMA_VERSION && isRecord(value.extensions);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
