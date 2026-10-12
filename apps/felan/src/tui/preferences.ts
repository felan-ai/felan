import { parseSchema, TuiPreferencesSchema, TuiPreferencesUpdateSchema, type TuiPreferences, type TuiPreferencesUpdate } from '@felan-ai/session-protocol';
import type { KeybindingsConfig } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { AgentViewTranscript } from '@felan-ai/ext-subagents/view';
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
      const field = await dialogs.select(`Settings · display defaults only${launchOverride ? '\nTheme/keybinding launch overrides remain active.' : ''}${error ? `\n${error}` : ''}`, [
        { value: 'theme', label: `Theme: ${draft.theme}`, description: 'Stored only in this TUI client configuration' },
        { value: 'hideThinking', label: `Thinking: ${draft.hideThinking ? 'hidden' : 'visible'}` },
        { value: 'showImages', label: `Images: ${draft.showImages ? 'shown' : 'hidden'}` },
        { value: 'imageWidthCells', label: `Image width: ${draft.imageWidthCells} cells` },
        { value: 'outputPad', label: `Output padding: ${draft.outputPad} cells` },
        { value: 'toolDisplay', label: `Tool display: ${draft.toolDisplay}` },
        { value: 'keybindings', label: 'Keybindings (JSON)', description: 'Action → key or key array; [] disables a binding' },
        { value: 'save', label: 'Save changes', description: 'Updates global defaults and this display, not running daemon execution' },
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
      } else if (field === 'hideThinking' || field === 'showImages') draft[field] = !draft[field];
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

  dispose(): void { this.closed = true; }
  private notice(error: unknown): void {
    if (!this.closed) this.controller.setNotice(`Client preferences: ${error instanceof Error ? error.message : String(error)}`);
  }
}
