import { getExtensionConfigCliOptions, parseModelReference, validateExtensionConfigValue, type ExtensionConfigDefinition, type ExtensionConfigOverride } from '@felan-ai/agent-core';
import { assertJson, ConfigValuesSchema, parseOperationResult, parseSchema, type OperationParams, type OperationResult, type JsonValue } from '@felan-ai/session-protocol';
import { EXECUTION_DEFAULT_KEYS, mergeDaemonGlobalSettings, readDaemonGlobalSettings, type DaemonGlobalSettingsUpdate } from './global-settings.js';
import type { HostConfiguration } from '@felan-ai/daemon/session-runtime';
import { builtinExtensionPackages, validateBuiltinExtensionKeys } from './extension-catalog.js';

export interface DaemonConfigurationOptions {
  agentDir: string;
  definitions: readonly ExtensionConfigDefinition[];
  assertCurrent(): void;
}

class ConfigurationUnavailable extends Error { readonly code = 'unavailable'; }

export class DaemonConfiguration implements HostConfiguration {
  private readonly fields;
  constructor(private readonly options: DaemonConfigurationOptions) {
    this.fields = new Map(getExtensionConfigCliOptions(options.definitions)
      .filter(field => Object.hasOwn(ConfigValuesSchema.properties, field.name)).map(field => [field.name, field]));
  }

  async get(scope: OperationParams<'config.get'>['scope'], model?: { provider: string; id: string }): Promise<OperationResult<'config.get'>> {
    this.requireGlobal(scope);
    const settings = await readDaemonGlobalSettings(this.options.agentDir, this.options.assertCurrent);
    const values: Record<string, unknown> = {};
    const configured = settings.extensionConfig;
    if (configured !== undefined && !record(configured)) throw new Error('extensionConfig must be an object');
    for (const [name, field] of this.fields) {
      const extension = record(configured) ? configured[field.extensionId] : undefined;
      if (extension !== undefined && !record(extension)) throw new Error(`extensionConfig.${field.extensionId} must be an object`);
      const value = record(extension) && Object.hasOwn(extension, field.field) ? extension[field.field] : field.configField.default;
      if (value !== undefined) values[name] = validateExtensionConfigValue(field.definition, field.field, value, 'daemon configuration');
    }
    const extensionConfig: Record<string, Record<string, unknown>> = {};
    const extensions = this.options.definitions.map(definition => {
      const stored = record(configured) ? configured[definition.id] : undefined;
      if (stored !== undefined && !record(stored)) throw new Error(`extensionConfig.${definition.id} must be an object`);
      const fields = Object.entries(definition.fields).filter(([, field]) => !field.deprecated);
      extensionConfig[definition.id] = Object.fromEntries(fields.filter(([, field]) => !field.sensitive).flatMap(([id, field]) => {
        const value = record(stored) && Object.hasOwn(stored, id) ? stored[id] : field.default;
        return value === undefined ? [] : [[id, validateExtensionConfigValue(definition, id, value, 'daemon configuration')]];
      }));
      return { id: definition.id, title: definition.title, fields: fields.map(([id, field]) => ({
        id, label: field.label ?? id, description: field.description, type: field.type,
        ...(field.sensitive ? { sensitive: true } : {}),
        ...(!field.sensitive && field.values ? { values: field.values } : {}),
      })) };
    }).filter(extension => extension.fields.length);
    values.extensionConfig = extensionConfig;
    if (settings.codemode !== undefined && !record(settings.codemode)) throw new Error('codemode must be an object');
    values.codemode = record(settings.codemode) ? settings.codemode.mode ?? 'on' : 'on';
    if (settings.compaction !== undefined && !record(settings.compaction)) throw new Error('compaction must be an object');
    values.autoCompact = record(settings.compaction) ? settings.compaction.enabled ?? true : true;
    values.cacheWarming = settings.cacheWarming ?? 'off';
    values.skillCommands = settings.enableSkillCommands ?? true;
    values.steeringMode = settings.steeringMode ?? 'one-at-a-time';
    values.followUpMode = settings.followUpMode ?? 'one-at-a-time';
    values.transport = settings.transport ?? 'auto';
    values.httpIdleTimeoutMs = settings.httpIdleTimeoutMs ?? 300000;
    values.modelThinkingLevels = settings.modelThinkingLevels ?? {};
    if (settings.images !== undefined && !record(settings.images)) throw new Error('images must be an object');
    if (record(settings.images)) {
      if (settings.images.autoResize !== undefined) values.imageAutoResize = settings.images.autoResize;
      if (settings.images.blockImages !== undefined) values.blockImages = settings.images.blockImages;
    }
    if (settings.enabledModels !== undefined) values.scopedModels = settings.enabledModels;
    if (settings.defaultProvider !== undefined || settings.defaultModel !== undefined) {
      if (typeof settings.defaultProvider !== 'string' || typeof settings.defaultModel !== 'string') throw new Error('Incomplete configured default model.');
      values.defaultModel = `${settings.defaultProvider}/${settings.defaultModel}`;
    }
    const modelThinkingLevels = parseSchema(ConfigValuesSchema, { modelThinkingLevels: values.modelThinkingLevels }).modelThinkingLevels;
    const defaultThinking = (model ? modelThinkingLevels?.[`${model.provider}/${model.id}`] : undefined) ?? settings.defaultThinkingLevel;
    if (defaultThinking !== undefined) values.defaultThinking = defaultThinking;
    if (settings.felanClassifier !== undefined) {
      if (!record(settings.felanClassifier)) throw new Error('felanClassifier must be an object');
      if (settings.felanClassifier.model !== undefined) values.classifierModel = settings.felanClassifier.model;
    }
    const builtins = settings.builtinExtensions;
    validateBuiltinExtensionKeys(builtins);
    values.builtinExtensions = Object.fromEntries(Object.keys(builtinExtensionPackages)
      .map(name => [name, builtins?.[name as keyof typeof builtinExtensionPackages] ?? true]));
    this.options.assertCurrent();
    return parseOperationResult('config.get', { values, extensions });
  }

  async set(scope: OperationParams<'config.set'>['scope'], input: unknown): Promise<void> {
    await mergeDaemonGlobalSettings(this.options.agentDir, this.prepare(scope, input), this.options.assertCurrent);
  }

  sessionOverrides(input: unknown, previous: readonly ExtensionConfigOverride[] = []): ReturnType<HostConfiguration['sessionOverrides']> {
    const update = this.prepare('global', input);
    if (EXECUTION_DEFAULT_KEYS.some(key => update[key] !== undefined)) throw new ConfigurationUnavailable('Execution defaults are global; use a new session or /reload, or restart the daemon for HTTP idle timeout.');
    if (update.imageAutoResize !== undefined || update.blockImages !== undefined) throw new ConfigurationUnavailable('Image settings are global; use a new session or /reload to apply them.');
    if (update.scopedModels !== undefined || update.defaultModel !== undefined || update.defaultThinking !== undefined) throw new ConfigurationUnavailable('Model defaults are global; use session model/thinking operations.');
    if (update.classifierModel !== undefined || update.builtinExtensions !== undefined || update.codemode !== undefined) throw new ConfigurationUnavailable('Classifier, code mode and built-in extension settings are global; use a new session or /reload to apply them.');
    const groups = new Map<string, { extensionId: string; source: string; values: Record<string, unknown> }>(previous.map(row => [row.extensionId, { ...row, values: { ...row.values } }]));
    for (const { definition, field, value } of update.extensions) {
      const group = groups.get(definition.id) ?? { extensionId: definition.id, source: 'CLI', values: {} };
      group.values[field] = value; groups.set(definition.id, group);
    }
    return [...groups.values()].map(group => ({ ...group, values: Object.fromEntries(Object.entries(group.values).map(([field, value]) => {
      assertJson(value); return [field, value as JsonValue];
    })) }));
  }

  async sessionValues(overrides: readonly ExtensionConfigOverride[]): Promise<OperationResult<'config.get'>> {
    const result = await this.get('global');
    for (const [name, field] of this.fields) {
      const row = overrides.find(row => row.extensionId === field.extensionId);
      if (row && Object.hasOwn(row.values, field.field)) {
        Object.assign(result.values, { [name]: validateExtensionConfigValue(field.definition, field.field, row.values[field.field], 'session configuration') });
      }
    }
    for (const extension of result.extensions ?? []) {
      const row = overrides.find(row => row.extensionId === extension.id);
      for (const field of extension.fields) {
        if (!field.sensitive && row && Object.hasOwn(row.values, field.id)) {
          const definition = this.options.definitions.find(item => item.id === extension.id)!;
          result.values.extensionConfig![extension.id]![field.id] = validateExtensionConfigValue(definition, field.id, row.values[field.id], 'session configuration') as JsonValue;
        }
      }
    }
    return parseOperationResult('config.get', result);
  }

  prepare(scope: OperationParams<'config.set'>['scope'], input: unknown): DaemonGlobalSettingsUpdate {
    this.requireGlobal(scope);
    const values = parseSchema(ConfigValuesSchema, input);
    validateBuiltinExtensionKeys(values.builtinExtensions);
    const extensions: DaemonGlobalSettingsUpdate['extensions'][number][] = [];
    for (const [name, value] of Object.entries(values)) {
      if (EXECUTION_DEFAULT_KEYS.some(key => key === name)) continue;
      if (name === 'scopedModels' || name === 'defaultModel' || name === 'defaultThinking' || name === 'classifierModel' || name === 'builtinExtensions' || name === 'extensionConfig' || name === 'codemode' || name === 'imageAutoResize' || name === 'blockImages') continue;
      const field = this.fields.get(name);
      if (!field) throw new ConfigurationUnavailable('Configuration field is not available in this daemon.');
      extensions.push({ definition: field.definition, field: field.field, value: validateExtensionConfigValue(field.definition, field.field, value, 'daemon configuration') });
    }
    for (const [id, fields] of Object.entries(values.extensionConfig ?? {})) {
      const definition = this.options.definitions.find(item => item.id === id);
      if (!definition) throw new ConfigurationUnavailable('Extension is not available in this daemon.');
      for (const [field, value] of Object.entries(fields)) {
        const config = definition.fields[field];
        if (!config || config.sensitive || config.deprecated) throw new ConfigurationUnavailable('Configuration field is unavailable.');
        extensions.push({ definition, field, value: validateExtensionConfigValue(definition, field, value, 'daemon configuration') });
      }
    }
    if (!Object.keys(values).length) throw new Error('Empty configuration update.');
    if (values.defaultModel && (!parseModelReference(values.defaultModel) || /[\x00-\x1f\x7f]/u.test(values.defaultModel))) throw new Error('Default model must be an exact provider/model-id.');
    if (values.scopedModels?.some(value => /[\x00-\x1f\x7f]/u.test(value))) throw new Error('Invalid configured model scope.');
    return { extensions,
      ...Object.fromEntries(EXECUTION_DEFAULT_KEYS.flatMap(key => values[key] === undefined ? [] : [[key, values[key]]])),
      ...(values.imageAutoResize === undefined ? {} : { imageAutoResize: values.imageAutoResize }),
      ...(values.blockImages === undefined ? {} : { blockImages: values.blockImages }),
      ...(values.codemode === undefined ? {} : { codemode: values.codemode }),
      ...(values.scopedModels === undefined ? {} : { scopedModels: values.scopedModels }),
      ...(values.defaultModel === undefined ? {} : { defaultModel: values.defaultModel }),
      ...(values.defaultThinking === undefined ? {} : { defaultThinking: values.defaultThinking }),
      ...(values.classifierModel === undefined ? {} : { classifierModel: values.classifierModel }),
      ...(values.builtinExtensions === undefined ? {} : { builtinExtensions: values.builtinExtensions }),
    };
  }

  private requireGlobal(scope: string): void {
    this.options.assertCurrent();
    if (scope !== 'global') throw new ConfigurationUnavailable('This configuration scope is unavailable; session model and thinking use their dedicated operations.');
  }
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
