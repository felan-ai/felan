import { ConfigValuesSchema, parseSchema, TuiPreferencesSchema, TuiPreferencesUpdateSchema, type TuiPreferences, type TuiPreferencesUpdate } from '@felan-ai/session-protocol';
import type { KeybindingsConfig } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { AgentViewTranscript } from '../subagents/types.js';
import type { TuiSessionController } from './controller.js';
import type { TuiDialogHost } from './dialogs.js';
import { parseClientKeybindings } from './keybindings.js';
import { ClientThemes } from './theme-config.js';

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

  async open(dialogs: TuiDialogHost): Promise<boolean> {
    if (!await this.load()) return false;
    const original = this.values; const draft = this.values;
    let error = '';
    while (!this.closed) {
      const launchOverride = this.overrides.theme !== undefined || Object.values(this.overrides.keybindings ?? {}).some(value => value !== undefined);
      const field = await dialogs.select(`Settings${launchOverride ? '\nTheme/keybinding launch overrides remain active.' : ''}${error ? `\n${error}` : ''}`, [
        { value: 'execution', label: 'Execution defaults…', description: 'Classifier model and built-in extensions; apply to new sessions or /reload' },
        { value: 'theme', label: `Theme: ${draft.theme}`, description: 'Stored only in this TUI client configuration' },
        { value: 'hideThinking', label: `Thinking: ${draft.hideThinking ? 'hidden' : 'visible'}` },
        { value: 'showImages', label: `Images: ${draft.showImages ? 'shown' : 'hidden'}` },
        { value: 'imageWidthCells', label: `Image width: ${draft.imageWidthCells} cells` },
        { value: 'outputPad', label: `Output padding: ${draft.outputPad} cells` },
        { value: 'toolDisplay', label: `Tool display: ${draft.toolDisplay}` },
        { value: 'keybindings', label: 'Keybindings (JSON)', description: 'Action → key or key array; [] disables a binding' },
        { value: 'save', label: 'Save display changes', description: 'Updates global defaults and this display, not running daemon execution' },
        { value: 'cancel', label: 'Cancel' },
      ]);
      if (field === undefined || field === 'cancel' || this.closed) return false;
      error = '';
      if (field === 'save') {
        const changes: Record<string, unknown> = {};
        for (const key of Object.keys(draft) as (keyof ClientTuiPreferences)[]) {
          if (JSON.stringify(draft[key]) !== JSON.stringify(original[key])) changes[key] = draft[key];
        }
        if (!Object.keys(changes).length) return true;
        if (await this.update(changes as ClientTuiPreferencesUpdate)) return true;
        error = this.controller.notice || 'Could not save. Your changes are retained; retry or cancel.';
      } else if (field === 'execution') await this.openExecutionSettings(dialogs);
      else if (field === 'hideThinking' || field === 'showImages') draft[field] = !draft[field];
      else if (field === 'theme') {
        const selected = await dialogs.select('Client theme', [
          ...this.themes.names.map(name => ({ value: `theme:${name}`, label: name })),
          { value: 'theme:felan-light/felan-dark', label: 'Automatic · Felan light/dark' },
          { value: 'pair', label: 'Custom light/dark pair' },
        ]);
        const next = selected === 'pair' ? await dialogs.input('Theme names: light/dark', draft.theme)
          : selected?.startsWith('theme:') ? selected.slice(6) : undefined;
        if (next !== undefined) {
          try { this.themes.validate(next); draft.theme = next; }
          catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
        }
      } else if (field === 'toolDisplay') {
        const selected = await dialogs.select('Tool display', [{ value: 'grouped', label: 'Grouped activity' }, { value: 'full', label: 'Full tool output' }]);
        if (selected === 'grouped' || selected === 'full') draft.toolDisplay = selected;
      } else if (field === 'imageWidthCells' || field === 'outputPad' || field === 'keybindings') {
        let text = field === 'keybindings' ? JSON.stringify(draft.keybindings) : String(draft[field]);
        let invalid = '';
        while (!this.closed) {
          const input = await dialogs.input(`${field}${field === 'imageWidthCells' ? ' (1–4096)' : field === 'outputPad' ? ' (0–16)' : ''}${invalid ? `\n${invalid}` : ''}`, text);
          if (input === undefined || this.closed) break;
          text = input;
          try {
            let value: unknown = input;
            if (field === 'keybindings') { value = JSON.parse(input); parseClientKeybindings(value); }
            else {
              if (!/^\d+$/u.test(input)) throw new Error('Enter a whole number in the displayed range.');
              value = Number(input);
            }
            Object.assign(draft, parseSchema(TuiPreferencesUpdateSchema, { [field]: value }));
            break;
          } catch (failure) { invalid = failure instanceof Error ? failure.message : String(failure); }
        }
      }
    }
    return false;
  }

  private async openExecutionSettings(dialogs: TuiDialogHost): Promise<void> {
    try {
      const response = await this.controller.perform('config.get', { scope: 'global' });
      if (response.outcome !== 'accepted' || this.closed) return;
      const original = parseSchema(ConfigValuesSchema, response.result.values);
      let classifierModel = original.classifierModel ?? 'auto';
      const builtinExtensions = { ...original.builtinExtensions };
      let error = '';
      while (!this.closed) {
        const field = await dialogs.select(`Execution defaults · new sessions or /reload${error ? `\n${error}` : ''}`, [
          { value: 'classifierModel', label: `Classifier model: ${classifierModel}` },
          ...Object.entries(builtinExtensions).map(([name, enabled]) => ({ value: `builtin:${name}`,
            label: `${name}: ${enabled ? 'enabled' : 'disabled'}` })),
          { value: 'save', label: 'Save execution defaults' }, { value: 'cancel', label: 'Back' },
        ]);
        if (field === undefined || field === 'cancel' || this.closed) return;
        error = '';
        if (field === 'classifierModel') {
          const selected = await dialogs.select('Classifier model', [
            { value: 'auto', label: 'Automatic' },
            ...(this.controller.snapshot?.catalog.models ?? []).map(model => ({ value: `${model.provider}/${model.id}`, label: model.label,
              description: `${model.provider}/${model.id}` })),
          ]);
          if (selected !== undefined) classifierModel = selected;
        } else if (field.startsWith('builtin:')) {
          const name = field.slice(8);
          builtinExtensions[name] = builtinExtensions[name] === false;
        } else if (field === 'save') {
          const changed = Object.fromEntries(Object.entries(builtinExtensions).filter(([name, enabled]) => enabled !== (original.builtinExtensions?.[name] ?? true)));
          const values = { ...(classifierModel === (original.classifierModel ?? 'auto') ? {} : { classifierModel }),
            ...(Object.keys(changed).length ? { builtinExtensions: changed } : {}) };
          if (!Object.keys(values).length) return;
          const saved = await this.controller.perform('config.set', { scope: 'global', values });
          if (this.closed) return;
          if (saved.outcome === 'accepted') {
            this.controller.setNotice('Execution defaults saved. Apply to new sessions or use /reload; running sessions are unchanged.');
            return;
          }
          error = this.controller.notice || 'Could not save. Retry or go back.';
        }
      }
    } catch (error) { this.notice(error); }
  }

  dispose(): void { this.closed = true; }
  private notice(error: unknown): void {
    if (!this.closed) this.controller.setNotice(`Client preferences: ${error instanceof Error ? error.message : String(error)}`);
  }
}
