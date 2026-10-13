import { parseOperationResult, parseSchema, TuiPreferencesSchema, TuiPreferencesUpdateSchema, type OperationParams, type TuiPreferences, type TuiPreferencesUpdate } from '@felan-ai/session-protocol';
import type { KeybindingsConfig } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { AgentViewTranscript } from '../subagents/types.js';
import type { TuiSessionController } from './controller.js';
import type { TuiDialogs } from './dialogs.js';
import { parseClientKeybindings } from './keybindings.js';
import { ClientThemes } from './theme-config.js';
import type { SettingsEntry } from './settings-menu.js';

export type ClientTuiPreferences = TuiPreferences & { theme: string };
type ClientTuiPreferencesUpdate = TuiPreferencesUpdate & { theme?: string };

export class TerminalPreferences {
  private stored: TuiPreferences = { hideThinking: false, showImages: true, imageWidthCells: 60, outputPad: 1, toolDisplay: 'grouped', keybindings: {} };
  private loaded = false;
  private loading: Promise<boolean> | undefined;
  private closed = false;

  constructor(private readonly controller: TuiSessionController,
    private readonly overrides: { theme?: string; keybindings?: KeybindingsConfig },
    private readonly changed: (preferences: ClientTuiPreferences, keybindings: KeybindingsConfig, theme: Theme) => Promise<void>,
    private readonly themes = new ClientThemes(undefined, overrides.theme)) {}

  get values(): ClientTuiPreferences { return { ...structuredClone(this.stored), theme: this.themes.value }; }
  get settings(): AgentViewTranscript['settings'] {
    const value = this.stored;
    return { hideThinking: value.hideThinking, showImages: value.showImages, imageWidthCells: value.imageWidthCells, outputPad: value.outputPad, toolMode: value.toolDisplay };
  }

  load(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (this.loaded) return Promise.resolve(true);
    return this.loading ??= this.read().finally(() => { this.loading = undefined; });
  }

  private async read(): Promise<boolean> {
    let themeError: unknown;
    try { await this.themes.load(); }
    catch (error) { themeError = error; }
    try {
      const response = await this.controller.perform('tui.preferences.get', {});
      if (response.outcome !== 'accepted' || this.closed) return false;
      const value = parseSchema(TuiPreferencesSchema, response.result);
      parseClientKeybindings(value.keybindings);
      this.stored = value; this.loaded = true;
      await this.apply();
      if (themeError !== undefined) this.notice(themeError);
      return true;
    } catch (error) { this.notice(error); return false; }
  }

  async update(value: ClientTuiPreferencesUpdate): Promise<boolean> {
    if (this.closed) return false;
    try {
      const { theme, ...remote } = value;
      if (theme !== undefined) this.themes.validate(theme);
      const values = Object.keys(remote).length ? parseSchema(TuiPreferencesUpdateSchema, remote) : undefined;
      if (values?.keybindings !== undefined) parseClientKeybindings(values.keybindings);
      if (values) {
        const response = await this.controller.perform('tui.preferences.set', { values });
        if (response.outcome !== 'accepted' || this.closed) return false;
        this.stored = { ...this.stored, ...values };
      }
      if (theme !== undefined) await this.themes.update(theme);
      this.controller.setNotice('Display preferences saved. Running daemon execution is unchanged.');
      await this.apply(); return true;
    } catch (error) { this.notice(error); return false; }
  }

  private apply(): Promise<void> {
    const keybindings = { ...parseClientKeybindings(this.stored.keybindings) };
    for (const [action, keys] of Object.entries(this.overrides.keybindings ?? {})) if (keys !== undefined) keybindings[action] = keys;
    return this.changed({ ...this.values, theme: this.overrides.theme ?? this.themes.value }, keybindings, this.themes.theme);
  }

  async open(dialogs: Pick<TuiDialogs, 'settings'>): Promise<boolean> {
    if (!await this.load()) return false;
    try {
      const response = await this.controller.perform('config.get', { scope: 'global' });
      if (response.outcome !== 'accepted' || this.closed) return false;
      const { values, extensions = [] } = parseOperationResult('config.get', response.result);
      const executionScope = 'Daemon defaults · new sessions or /reload; running sessions unchanged.';
      const displayScope = 'Display only · saved defaults and this client; execution unchanged.';
      const models = (this.controller.snapshot?.catalog.models ?? []).map(model => ({ value: `${model.provider}/${model.id}`, label: model.label }));
      const save = async (values: OperationParams<'config.set'>['values']) => {
        if (this.closed) throw new Error('Settings closed.');
        const result = await this.controller.perform('config.set', { scope: 'global', values });
        if (result.outcome !== 'accepted') throw new Error(result.error.message);
        this.controller.setNotice('Settings saved. Apply to new sessions or use /reload; running sessions are unchanged.');
      };
      const display = (id: keyof ClientTuiPreferences, label: string, description: string, options: Partial<SettingsEntry> = {}): SettingsEntry => ({
        id, label, description: `${description} ${displayScope}`, currentValue: typeof this.values[id] === 'object' ? JSON.stringify(this.values[id]) : String(this.values[id]),
        ...options,
        change: async value => {
          let parsed: unknown = value;
          if (id === 'hideThinking' || id === 'showImages') parsed = value === 'true';
          if (id === 'imageWidthCells' || id === 'outputPad') {
            if (!/^\d+$/u.test(value)) throw new Error('Enter a whole number in the displayed range.');
            parsed = Number(value);
          }
          if (id === 'keybindings') parsed = JSON.parse(value);
          if (!await this.update({ [id]: parsed } as ClientTuiPreferencesUpdate)) throw new Error(this.controller.notice || 'Could not save display preference.');
          return typeof parsed === 'object' ? JSON.stringify(parsed) : String(parsed);
        },
      });
      const launchOverride = this.overrides.theme !== undefined || Object.values(this.overrides.keybindings ?? {}).some(value => value !== undefined);
      const general: SettingsEntry[] = [
        display('theme', 'Theme', `Choose a theme or a custom light/dark pair.${launchOverride ? ' Launch overrides remain active.' : ''}`, { edit: true,
          choices: [...this.themes.names.map(name => ({ value: name, label: name })), { value: 'felan-light/felan-dark', label: 'Automatic · Felan light/dark' }] }),
        display('hideThinking', 'Hide thinking', '', { values: ['false', 'true'] }),
        display('showImages', 'Show images', '', { values: ['true', 'false'] }),
        display('imageWidthCells', 'Image width', 'Width in cells (1–4096).', { edit: true }),
        display('outputPad', 'Output padding', 'Padding in cells (0–16).', { edit: true }),
        display('toolDisplay', 'Tool display', '', { values: ['grouped', 'full'] }),
        display('keybindings', 'Keybindings (JSON)', `Action → key or key array; [] disables a binding.${launchOverride ? ' Launch overrides remain active.' : ''}`, { edit: true }),
        { id: 'defaultModel', label: 'Default model', currentValue: values.defaultModel ?? 'not set', description: executionScope,
          choices: models, change: async value => save({ defaultModel: value }) },
        { id: 'defaultThinking', label: 'Default thinking', currentValue: values.defaultThinking ?? 'off', description: executionScope,
          values: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], change: async value => save({ defaultThinking: value as NonNullable<typeof values.defaultThinking> }) },
        { id: 'scopedModels', label: 'Enabled models (JSON)', currentValue: JSON.stringify(values.scopedModels ?? []), description: executionScope,
          edit: true, change: async value => { await save({ scopedModels: JSON.parse(value) }); } },
        { id: 'builtins', label: 'Built-in extensions', currentValue: 'open', description: executionScope,
          children: Object.entries(values.builtinExtensions ?? {}).map(([id, enabled]) => ({ id, label: id, currentValue: String(enabled),
            description: executionScope, values: ['true', 'false'], change: async value => save({ builtinExtensions: { [id]: value === 'true' } }) })) },
      ];
      await dialogs.settings([
        { id: 'general', label: 'General settings', currentValue: 'open', description: 'Client display settings and daemon execution defaults.', children: general },
        { id: 'codemode', label: 'Code mode', currentValue: values.codemode ?? 'on', description: executionScope,
          values: ['off', 'on', 'only'], change: async value => save({ codemode: value as NonNullable<typeof values.codemode> }) },
        { id: 'classifierModel', label: 'Classifier model', currentValue: values.classifierModel ?? 'auto', description: executionScope,
          choices: [{ value: 'auto', label: 'Automatic' }, ...models], change: async value => save({ classifierModel: value }) },
        ...extensions.map(extension => ({ id: extension.id, label: extension.title,
          currentValue: `${extension.fields.length} ${extension.fields.length === 1 ? 'setting' : 'settings'}`, description: `Configure ${extension.title}. ${executionScope}`,
          children: extension.fields.map(field => {
            if (field.sensitive) return { id: field.id, label: field.label, currentValue: 'protected',
              description: `${field.description} Sensitive setting · not editable in this selector.` };
            const current = values.extensionConfig?.[extension.id]?.[field.id];
            return { id: field.id, label: field.label, description: `${field.description} ${executionScope}`,
              currentValue: current === undefined ? 'not set' : field.type === 'json' ? JSON.stringify(current) : String(current),
              ...(field.values ? { values: field.values.map(String) } : field.type === 'boolean' ? { values: ['true', 'false'] } : { edit: true }),
              change: async (value: string) => {
                const parsed = field.type === 'boolean' ? value === 'true' : field.type === 'json' ? JSON.parse(value) : field.type === 'number' ? Number(value) : value;
                if (field.type === 'number' && (!value.trim() || !Number.isFinite(parsed))) throw new Error('Enter a finite number.');
                await save({ extensionConfig: { [extension.id]: { [field.id]: parsed } } });
                return field.type === 'json' ? JSON.stringify(parsed) : String(parsed);
              },
            };
          }),
        })),
      ]);
      return true;
    } catch (error) { this.notice(error); return false; }
  }

  dispose(): void { this.closed = true; }
  private notice(error: unknown): void {
    if (!this.closed) this.controller.setNotice(`Client preferences: ${error instanceof Error ? error.message : String(error)}`);
  }
}
