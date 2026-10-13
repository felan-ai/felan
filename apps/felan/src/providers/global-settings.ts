import {
  SettingsManager,
  parseModelReference,
  validateExtensionConfigValue,
  type ExtensionConfigDefinition,
} from '@felan-ai/agent-core';
import { ConfigValuesSchema, LIMITS, ThinkingSchema, TuiPreferencesUpdateSchema, assertJson, parseSchema, type TuiPreferencesUpdate } from '@felan-ai/session-protocol';
import { readDaemonSettingsStore, updateDaemonSettingsStore, type MutableDaemonGlobalSettings } from './settings-store.js';
import { validateBuiltinExtensionKeys } from './extension-catalog.js';

export type DaemonGlobalSettings = Readonly<Record<string, unknown>>;

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

export function createDaemonSettingsManager(cwd: string, agentDir: string): SettingsManager {
  return SettingsManager.create(cwd, agentDir, { projectTrusted: false });
}

export function getPiExtensionSettings(settingsManager: SettingsManager): ResolvedPiExtensionSettings {
  return parsePiExtensionSettings((settingsManager.getGlobalSettings() as Record<string, unknown>).piExtensions);
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

export interface DependencyOnboardingDecision {
  readonly extension: string;
  readonly revision: number;
  readonly enabled: boolean;
}

export interface DaemonGlobalSettingsUpdate {
  readonly extensions: readonly { definition: ExtensionConfigDefinition; field: string; value: unknown }[];
  readonly scopedModels?: readonly string[];
  readonly defaultModel?: string;
  readonly defaultThinking?: string;
  readonly classifierModel?: string;
  readonly codemode?: 'off' | 'on' | 'only';
  readonly builtinExtensions?: Readonly<Record<string, boolean>>;
  readonly preferences?: TuiPreferencesUpdate;
  readonly dependencyDecisions?: readonly DependencyOnboardingDecision[];
}

export function parseClassifierModelSetting(value: unknown): string {
  if (value === undefined) return 'auto';
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/u.test(value) || Buffer.byteLength(value) > LIMITS.idBytes) throw new Error('felanClassifier.model must be "auto" or an exact provider/model-id');
  const normalized = value.trim();
  if (normalized === 'auto') return normalized;
  const reference = parseModelReference(normalized);
  if (!reference) throw new Error('felanClassifier.model must be "auto" or an exact provider/model-id');
  return `${reference.provider}/${reference.id}`;
}

export async function mergeDaemonGlobalSettings(
  agentDir: string, update: DaemonGlobalSettingsUpdate, assertCurrent: () => void,
): Promise<void> {
  const extensions = update.extensions.map(({ definition, field, value }) => {
    assertJson(value, LIMITS.structuredBytes);
    const config = definition.fields[field];
    if (!config || config.sensitive) throw new Error('Configuration field is unavailable.');
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
  const classifierModel = update.classifierModel === undefined ? undefined : parseClassifierModelSetting(update.classifierModel);
  const codemode = update.codemode === undefined ? undefined : parseSchema(ConfigValuesSchema, { codemode: update.codemode }).codemode;
  const builtins = update.builtinExtensions;
  validateBuiltinExtensionKeys(builtins);
  const preferences = update.preferences === undefined ? undefined : parseSchema(TuiPreferencesUpdateSchema, update.preferences);
  const decisions = update.dependencyDecisions ?? [];
  if (decisions.length > 16 || decisions.some(value => !isExtensionIdentifier(value.extension)
    || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.enabled !== 'boolean')) throw new Error('Invalid dependency decisions.');
  if (!extensions.length && !Object.keys(defaults).length && !preferences && !decisions.length && !builtins && classifierModel === undefined && codemode === undefined) throw new Error('Empty configuration update.');
  await updateDaemonGlobalSettings(agentDir, assertCurrent, settings => {
    if (codemode !== undefined) {
      if (settings.codemode !== undefined && !isRecord(settings.codemode)) throw new Error('codemode must be an object');
      settings.codemode = { ...settings.codemode, mode: codemode };
    }
    if (classifierModel !== undefined) {
      if (settings.felanClassifier !== undefined && !isRecord(settings.felanClassifier)) throw new Error('felanClassifier must be an object');
      settings.felanClassifier = { ...settings.felanClassifier, model: classifierModel };
    }
    if (builtins) {
      if (settings.builtinExtensions !== undefined && !isRecord(settings.builtinExtensions)) throw new Error('builtinExtensions must be an object');
      settings.builtinExtensions = { ...settings.builtinExtensions, ...builtins };
    }
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
      tui.onboarding = { schemaVersion: 1, extensions: versions }; delete tui.dependencyOnboarding;
      settings.felanTui = tui; settings.builtinExtensions = builtins;
    }
    Object.assign(settings, defaults);
  });
}

export async function readDaemonGlobalSettings(agentDir: string, assertCurrent: () => void): Promise<DaemonGlobalSettings> {
  return readDaemonSettingsStore(agentDir, assertCurrent);
}

export async function updateDaemonGlobalSettings(
  agentDir: string,
  assertCurrent: () => void,
  update: (settings: MutableDaemonGlobalSettings) => void,
): Promise<void> {
  await updateDaemonSettingsStore(agentDir, assertCurrent, update);
}

export function isBuiltinExtensionEnabled(settings: DaemonGlobalSettings, name: string): boolean {
  const builtins = settings.builtinExtensions;
  return !isRecord(builtins) || builtins[name] !== false;
}

export function isDependencyOnboardingComplete(
  settings: DaemonGlobalSettings,
  extension: string,
  revision: number,
): boolean {
  const tui = settings.felanTui;
  if (!isRecord(tui)) return false;
  const onboarding = tui.onboarding;
  return isCurrentOnboardingSettings(onboarding) && onboarding.extensions[extension] === revision;
}

function currentOnboardingExtensions(value: unknown): Record<string, unknown> {
  return isCurrentOnboardingSettings(value) ? { ...value.extensions } : {};
}

function isCurrentOnboardingSettings(value: unknown): value is { readonly schemaVersion: 1; readonly extensions: Readonly<Record<string, unknown>> } {
  return isRecord(value) && value.schemaVersion === 1 && isRecord(value.extensions);
}

function isExtensionIdentifier(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value) <= LIMITS.idBytes && /^[A-Za-z][A-Za-z0-9_-]*$/u.test(value);
}

function optionalBooleanSetting(value: unknown, path: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
