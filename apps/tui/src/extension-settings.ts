import { validateExtensionConfigValue } from '@felan-ai/agent-core';
import type { ExtensionConfigDefinition, ExtensionConfigField, ExtensionConfigValue, SettingsManager } from '@felan-ai/agent-core';
import { getSettingsListTheme } from '@earendil-works/pi-coding-agent';
import {
  Container,
  Input,
  SettingsList,
  Spacer,
  Text,
  type Component,
  type Focusable,
  type SettingItem,
} from '@earendil-works/pi-tui';
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
  const state = loadExtensionSettingsState(options);
  internals.showSettingsSelector = () => {
    internals.showSelector((done) => {
      const items: SettingItem[] = [
        {
          id: 'native-settings',
          label: 'Pi settings',
          description: 'Open the standard Felan runtime settings selector',
          currentValue: 'open',
          submenu: () => showNativeSettings(internals, mode, nativeSettings),
        },
        ...options.definitions.map((definition) => {
          const fieldCount = Object.keys(definition.fields).length;
          return {
            id: definition.id,
            label: definition.title,
            description: `Configure ${definition.title} extension settings`,
            currentValue: `${fieldCount} ${fieldCount === 1 ? 'setting' : 'settings'}`,
            submenu: (_currentValue: string, close: (selectedValue?: string) => void) =>
              createExtensionSettingsList(
                options,
                definition,
                state,
                () => close(),
                () => internals.ui?.requestRender(),
              ),
          };
        }),
      ];
      const list = new SettingsList(
        items,
        Math.min(items.length, 12),
        getSettingsListTheme(),
        () => {},
        done,
        { enableSearch: true },
      );
      return { component: list, focus: list as unknown as Focusable };
    });
  };
}

type ExtensionSettingValues = Map<string, Map<string, unknown>>;

interface ExtensionSettingsState {
  readonly persistedValues: ExtensionSettingValues;
  readonly revisions: Map<string, Map<string, number>>;
  readonly values: ExtensionSettingValues;
  pendingWrite: Promise<void>;
}

function loadExtensionSettingsState(options: InstallFelanSettingsOptions): ExtensionSettingsState {
  const settings = getFelanSettings(options.settingsManager);
  const stored = settings.extensionConfig ?? {};
  const values = new Map(options.definitions.map((definition) => {
    const configured = stored[definition.id];
    return [definition.id, new Map(Object.entries(definition.fields).map(([field, config]) => [
      field,
      configured && Object.hasOwn(configured, field) ? configured[field] : config.default,
    ]))];
  }));
  return {
    persistedValues: new Map([...values].map(([extensionId, fields]) => [extensionId, new Map(fields)])),
    revisions: new Map([...values].map(([extensionId, fields]) => [
      extensionId,
      new Map([...fields.keys()].map((field) => [field, 0])),
    ])),
    values,
    pendingWrite: Promise.resolve(),
  };
}

function showNativeSettings(
  internals: SettingsModeInternals,
  mode: object,
  nativeSettings: () => void,
): Component {
  const showSelector = internals.showSelector;
  internals.showSelector = (create) => {
    showSelector.call(mode, (done) => create(() => {
      done();
      internals.showSettingsSelector();
    }));
  };
  try {
    nativeSettings();
  } finally {
    internals.showSelector = showSelector;
  }
  return new Container();
}

function createExtensionSettingsList(
  options: InstallFelanSettingsOptions,
  definition: ExtensionConfigDefinition,
  state: ExtensionSettingsState,
  onCancel: () => void,
  requestRender: () => void,
): SettingsList {
  const items = createExtensionSettingItems(definition, state.values);
  const list = new SettingsList(
    items,
    Math.min(items.length, 12),
    getSettingsListTheme(),
    (field, value) => {
      const configField = definition.fields[field];
      if (!configField) return;
      const extensionValues = state.values.get(definition.id);
      const revisions = state.revisions.get(definition.id);
      const revision = (revisions?.get(field) ?? 0) + 1;
      const parsed = validateExtensionConfigValue(
        definition,
        field,
        parseExtensionSettingValue(configField, value),
        `setting ${definition.id}.${field}`,
      );
      revisions?.set(field, revision);
      extensionValues?.set(field, parsed);
      list.updateValue(field, formatExtensionSettingDisplayValue(configField, parsed));
      void enqueueExtensionSettingWrite(options, state, definition.id, field, parsed).catch(() => {
        if (revisions?.get(field) !== revision) return;
        const persistedValues = state.persistedValues.get(definition.id);
        const persisted = persistedValues?.has(field) ? persistedValues.get(field) : configField.default;
        extensionValues?.set(field, persisted);
        list.updateValue(field, `${formatExtensionSettingDisplayValue(configField, persisted)} (save failed)`);
        requestRender();
      });
    },
    onCancel,
    { enableSearch: true },
  );
  return list;
}

async function enqueueExtensionSettingWrite(
  options: InstallFelanSettingsOptions,
  state: ExtensionSettingsState,
  extensionId: string,
  field: string,
  value: ExtensionConfigValue,
): Promise<void> {
  const write = state.pendingWrite.then(async () => {
    await setExtensionConfigValue(options.agentDir, extensionId, field, value);
    state.persistedValues.get(extensionId)?.set(field, value);
    await options.settingsManager.reload().catch(() => {});
  });
  state.pendingWrite = write.catch(() => {});
  await write;
}

function createExtensionSettingItems(
  definition: ExtensionConfigDefinition,
  values: ExtensionSettingValues,
): SettingItem[] {
  const currentValues = values.get(definition.id);
  return Object.entries(definition.fields).map(([field, config]) => {
    const currentValue = (): unknown => currentValues?.has(field) ? currentValues.get(field) : config.default;
    const value = currentValue();
    const selectableValues = config.values?.map(String)
      ?? (config.type === 'boolean' ? ['true', 'false'] : undefined);
    const item: SettingItem = {
      id: field,
      label: config.label ?? field,
      description: config.description,
      currentValue: formatExtensionSettingDisplayValue(config, value),
      ...(selectableValues === undefined ? {} : { values: selectableValues }),
    };
    if (selectableValues === undefined && (
      config.type === 'string'
      || config.type === 'number'
      || config.type === 'json'
    )) {
      item.submenu = (_currentValue: string, done: (selectedValue?: string) => void) => new StringSetting(
        formatExtensionSettingInputValue(config, currentValue()),
        (next) => {
          if (config.sensitive === true && next.length === 0) {
            done();
            return;
          }
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
  });
}

class StringSetting extends Container {
  readonly #input = new Input();
  readonly #error = new Text('', 0, 0);

  constructor(value: string, onSubmit: (value: string) => void, onCancel: () => void) {
    super();
    this.addChild(new Text('Enter a value:', 0, 0));
    this.addChild(new Spacer(1));
    this.#input.setValue(value);
    this.#input.onSubmit = (next) => {
      try {
        onSubmit(next);
      } catch (error) {
        this.#error.setText(`Invalid value: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    this.#input.onEscape = onCancel;
    this.addChild(this.#input);
    this.addChild(this.#error);
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
