import { validateExtensionConfigValue } from '@felan-ai/agent-core';
import type { ExtensionConfigDefinition, ExtensionConfigField, ExtensionConfigValue, SettingsManager } from '@felan-ai/agent-core';
import { getSettingsListTheme } from '@earendil-works/pi-coding-agent';
import { Container, Input, SettingsList, Spacer, Text, type Component, type Focusable } from '@earendil-works/pi-tui';
import { getFelanSettings, setExtensionConfigValue } from './settings.js';

interface SettingsModeInternals {
  editor: Focusable;
  editorContainer: Container;
  ui: { setFocus(focus: Focusable): void; requestRender(): void };
  showSettingsSelector(): void;
  showSelector(create: (done: () => void) => {
    component: Component;
    focus: Focusable;
    dispose?: () => void;
  }): void;
}

export interface InstallFelanSettingsOptions {
  readonly agentDir: string;
  readonly settingsManager: SettingsManager;
  readonly definitions: readonly ExtensionConfigDefinition[];
}

export function installFelanSettingsCommand(
  mode: object,
  options: InstallFelanSettingsOptions,
): void {
  const internals = mode as unknown as SettingsModeInternals;
  if (typeof internals.showSelector !== 'function' || typeof internals.showSettingsSelector !== 'function') {
    return;
  }
  const nativeSettings = internals.showSettingsSelector.bind(mode);
  internals.showSettingsSelector = () => {
    internals.showSelector((done) => {
      const items = [
        {
          id: 'native-settings',
          label: 'Pi settings',
          description: 'Open the standard Felan runtime settings selector',
          currentValue: 'open',
          submenu: () => {
            nativeSettings();
            done();
            return new Container();
          },
        },
        ...createItems(options),
      ];
      const list = new SettingsList(items, Math.min(items.length, 12), getSettingsListTheme(), async (id, value) => {
        if (id === 'native-settings') return;
        const [extensionId, field] = id.split('.', 2);
        if (!extensionId || !field) return;
        const definition = options.definitions.find((candidate) => candidate.id === extensionId);
        const configField = definition?.fields[field];
        if (!definition || !configField) return;
        const parsed = validateExtensionConfigValue(
          definition,
          field,
          parseExtensionSettingValue(configField, value),
          `setting ${extensionId}.${field}`,
        );
        await setExtensionConfigValue(options.agentDir, extensionId, field, parsed);
        list.updateValue(id, formatExtensionSettingDisplayValue(configField, parsed));
      }, done, { enableSearch: true });
      return { component: list, focus: list as unknown as Focusable };
    });
  };
}

function createItems(options: InstallFelanSettingsOptions): Array<{
  id: string;
  label: string;
  description: string;
  currentValue: string;
  values?: string[];
  submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
}> {
  const settings = getFelanSettings(options.settingsManager);
  const stored = settings.extensionConfig ?? {};
  return options.definitions.flatMap((definition) => Object.entries(definition.fields).map(([field, config]) => {
    const value = stored[definition.id]?.[field] ?? config.default;
    const item: {
      id: string;
      label: string;
      description: string;
      currentValue: string;
      values?: string[];
      submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
    } = {
      id: `${definition.id}.${field}`,
      label: `${definition.title}: ${config.label ?? field}`,
      description: config.description,
      currentValue: formatExtensionSettingDisplayValue(config, value),
      ...(config.values === undefined ? {} : { values: config.values.map(String) }),
    };
    if (config.type === 'string' || config.type === 'json') {
      item.submenu = (_currentValue: string, done: (selectedValue?: string) => void) => new StringSetting(
        formatExtensionSettingInputValue(config, value),
        (next) => {
          validateExtensionConfigValue(
            definition,
            field,
            parseExtensionSettingValue(config, next),
            `setting ${definition.id}.${field}`,
          );
          done(next);
        },
        () => done(),
      );
    }
    return item;
  }));
}

class StringSetting extends Container {
  readonly #input = new Input();

  constructor(value: string, onSubmit: (value: string) => void, onCancel: () => void) {
    super();
    this.addChild(new Text('Enter a value:', 0, 0));
    this.addChild(new Spacer(1));
    this.#input.setValue(value);
    this.#input.onSubmit = onSubmit;
    this.#input.onEscape = onCancel;
    this.addChild(this.#input);
  }

  handleInput(data: string): void {
    this.#input.handleInput(data);
  }
}

export function parseExtensionSettingValue(
  field: ExtensionConfigField,
  value: string,
): ExtensionConfigValue {
  if (field.sensitive === true && value.length === 0) {
    return field.default as ExtensionConfigValue;
  }
  if (field.type === 'boolean') return value === 'true';
  if (field.type === 'number') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`Setting value must be a number: ${value}`);
    return parsed;
  }
  if (field.type === 'json') {
    try {
      return JSON.parse(value) as ExtensionConfigValue;
    } catch (error) {
      throw new Error(`Setting value must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return value;
}

export function formatExtensionSettingDisplayValue(
  field: ExtensionConfigField,
  value: unknown,
): string {
  if (field.sensitive === true) return hasConfiguredValue(value) ? 'configured' : 'not set';
  return field.type === 'json' ? JSON.stringify(value) ?? 'null' : String(value);
}

export function formatExtensionSettingInputValue(
  field: ExtensionConfigField,
  value: unknown,
): string {
  return field.sensitive === true ? '' : formatExtensionSettingDisplayValue(field, value);
}

function hasConfiguredValue(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value !== undefined && value !== null && value !== false;
}
