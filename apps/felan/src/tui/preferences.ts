import { ConfigValuesSchema, parseOperationResult, parseSchema, TuiPreferencesSchema, TuiPreferencesUpdateSchema, type OperationParams, type TuiPreferences, type TuiPreferencesUpdate } from '@felan-ai/session-protocol';
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
    return { hideThinking: value.hideThinking, showImages: value.showImages, imageWidthCells: value.imageWidthCells, outputPad: value.outputPad, toolMode: value.toolDisplay,
      ...(value.mermaid === undefined ? {} : { mermaid: value.mermaid }) };
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
        const result = await this.controller.perform('config.set', { scope: 'global', values: parseSchema(ConfigValuesSchema, values) });
        if (result.outcome !== 'accepted') throw new Error(result.error.message);
        this.controller.setNotice(values.httpIdleTimeoutMs === undefined ? 'Settings saved. Apply to new sessions or use /reload; running sessions are unchanged.'
          : 'HTTP idle timeout saved. Restart the daemon to apply it; running sessions are unchanged.');
      };
      const execution = (id: keyof OperationParams<'config.set'>['values'], label: string, fallback: string | number | boolean | Record<string, string>, description: string, options: Partial<SettingsEntry>): SettingsEntry => ({
        id, label, description: `${description} ${id === 'httpIdleTimeoutMs' ? 'Daemon process default · restart the daemon to apply.' : executionScope}`,
        currentValue: typeof fallback === 'object' ? JSON.stringify(values[id] ?? fallback) : String(values[id] ?? fallback), ...options,
        change: async value => {
          if (typeof fallback === 'number' && !/^\d+$/u.test(value)) throw new Error('Enter a non-negative whole number.');
          await save({ [id]: typeof fallback === 'boolean' ? value === 'true' : typeof fallback === 'number' ? Number(value)
            : typeof fallback === 'object' ? JSON.parse(value) : value });
        },
      });
      const display = (id: keyof ClientTuiPreferences, label: string, description: string, options: Partial<SettingsEntry> = {}): SettingsEntry => ({
        id, label, description: `${description} ${displayScope}`, currentValue: typeof this.values[id] === 'object' ? JSON.stringify(this.values[id])
          : String(this.values[id] ?? ({ hardwareCursor: false, editorPadding: 1, autocompleteMaxVisible: 5, clearOnShrink: false, terminalProgress: false,
            mermaid: 'streaming', quietStartup: false, fullscreenScrollbar: 'auto', fullscreenCopyOnSelect: true, fullscreenWheelScrollLines: 'auto' } as Record<string, unknown>)[id]),
        ...options,
        change: async value => {
          let parsed: unknown = value;
          if (['hideThinking', 'showImages', 'hardwareCursor', 'clearOnShrink', 'terminalProgress', 'fullscreenCopyOnSelect'].includes(id)
            || id === 'quietStartup' && value !== 'header') parsed = value === 'true';
          if (['imageWidthCells', 'outputPad', 'editorPadding', 'autocompleteMaxVisible'].includes(id) || id === 'fullscreenWheelScrollLines' && value !== 'auto') {
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
          preview: value => { this.themes.preview(value); void this.apply().catch(error => this.notice(error)); },
          choices: [...this.themes.names.map(name => ({ value: name, label: name, ...(name === 'system' ? { description: "Theme created from your terminal's colors" } : {}) })), { value: 'felan-light/felan-dark', label: 'Automatic · Felan light/dark', description: 'Follow the terminal light/dark appearance.' }] }),
        display('hideThinking', 'Hide thinking', '', { values: ['false', 'true'] }),
        display('showImages', 'Show images', '', { values: ['true', 'false'] }),
        display('imageWidthCells', 'Image width', 'Width in cells (1–4096).', { edit: true }),
        display('outputPad', 'Output padding', 'Padding in cells (0–16).', { edit: true }),
        display('toolDisplay', 'Tool display', '', { values: ['grouped', 'full'] }),
        display('hardwareCursor', 'Hardware cursor', 'Show the terminal cursor.', { values: ['false', 'true'] }),
        display('editorPadding', 'Editor padding', 'Horizontal padding in cells (0–3).', { values: ['0', '1', '2', '3'] }),
        display('autocompleteMaxVisible', 'Autocomplete size', 'Visible suggestions (3–20).', { edit: true }),
        display('clearOnShrink', 'Clear on shrink', 'Clear vacated terminal rows when content shrinks.', { values: ['false', 'true'] }),
        display('terminalProgress', 'Terminal progress', 'Report active work in supported terminal tabs.', { values: ['false', 'true'] }),
        display('mermaid', 'Mermaid diagrams', 'Render Mermaid code blocks as Unicode diagrams.', { values: ['off', 'final', 'streaming'] }),
        display('quietStartup', 'Quiet startup', 'Hide the startup header (true), show only its title (header), or show all hints (false).', { values: ['false', 'header', 'true'] }),
        display('fullscreenScrollbar', 'Fullscreen scrollbar', 'Transcript scrollbar visibility.', { values: ['auto', 'always', 'hidden'] }),
        display('fullscreenCopyOnSelect', 'Fullscreen copy on select', 'Automatically copy selected text; when off, copy explicitly.', { values: ['true', 'false'] }),
        display('fullscreenWheelScrollLines', 'Fullscreen wheel scrolling', 'Lines per wheel event; auto accelerates fast scrolling.', { values: ['auto', '1', '2', '3', '5', '10'] }),
        execution('autoCompact', 'Auto-compact', true, 'Automatically compact context when it gets too large.', { values: ['true', 'false'] }),
        execution('skillCommands', 'Skill commands', true, 'Register skills as /skill:name commands.', { values: ['true', 'false'] }),
        execution('steeringMode', 'Steering mode', 'one-at-a-time', 'Deliver queued steering messages individually or all at once.', { values: ['one-at-a-time', 'all'] }),
        execution('followUpMode', 'Follow-up mode', 'one-at-a-time', 'Deliver queued follow-up messages individually or all at once.', { values: ['one-at-a-time', 'all'] }),
        execution('transport', 'Transport', 'auto', 'Preferred transport for providers that support multiple transports.', { values: ['sse', 'websocket', 'websocket-cached', 'auto'] }),
        execution('httpIdleTimeoutMs', 'HTTP idle timeout (ms)', 300000, 'Maximum idle gap awaiting HTTP data; 0 disables the timeout.', { edit: true }),
        execution('cacheWarming', 'Cache warming', 'off', 'Off, while streaming, or also while idle when continuation is profitable.', { values: ['off', 'streaming', 'idle'] }),
        execution('modelThinkingLevels', 'Default thinking level per model (JSON)', {}, 'Exact provider/model-id → level; {} clears overrides.', { edit: true }),
        { id: 'imageAutoResize', label: 'Auto-resize images', currentValue: String(values.imageAutoResize ?? true), description: `Resize image input before sending to the model. ${executionScope}`,
          values: ['true', 'false'], change: async value => save({ imageAutoResize: value === 'true' }) },
        { id: 'blockImages', label: 'Block images', currentValue: String(values.blockImages ?? false), description: `Prevent images from being sent to the model. ${executionScope}`,
          values: ['false', 'true'], change: async value => save({ blockImages: value === 'true' }) },
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
    finally { this.themes.preview(undefined); if (!this.closed) await this.apply(); }
  }

  dispose(): void { this.closed = true; }
  private notice(error: unknown): void {
    if (!this.closed) this.controller.setNotice(`Client preferences: ${error instanceof Error ? error.message : String(error)}`);
  }
}
