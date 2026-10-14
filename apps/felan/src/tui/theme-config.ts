import { opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { ClientPreferencesStore, directory, readBounded } from './preferences-store.js';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { TerminalColors } from '@earendil-works/pi-tui';
import { bundledClientThemes, parseClientTheme, systemClientTheme, themeName, themeSetting, THEME_BYTES } from './theme.js';

export class ClientThemes {
  readonly settings: ClientPreferencesStore;
  private catalog = bundledClientThemes();
  private previewSetting: string | undefined;
  private terminalColors: TerminalColors = {};
  private appearance: 'dark' | 'light';
  private loaded = false;
  private notices: string[] = [];

  constructor(private readonly root?: string, private readonly override?: string, appearance?: 'dark' | 'light') {
    this.settings = new ClientPreferencesStore(root);
    this.appearance = appearance ?? (/^(?:[^;]*;)*(?:7|9|1[0-5])$/u.test(process.env.COLORFGBG ?? '') ? 'light' : 'dark');
    if (override !== undefined) themeSetting(override);
  }
  get value(): string { return this.settings.values.theme; }
  get theme(): Theme {
    const names = (this.previewSetting ?? this.override ?? this.value).split('/');
    const selected = names.length === 2 ? names[this.appearance === 'light' ? 0 : 1]! : names[0]!;
    return this.catalog.get(selected) ?? this.catalog.get('felan-dark')!;
  }
  get warnings(): readonly string[] { return [...this.notices, ...this.settings.warnings]; }
  get names(): string[] { return [...this.catalog.keys()].sort(); }
  setAppearance(value: 'dark' | 'light'): void { this.appearance = value; this.setTerminalColors(this.terminalColors); }
  setTerminalColors(value: TerminalColors): void { this.terminalColors = value; this.catalog.set('system', systemClientTheme(value, this.appearance)); }
  preview(value: string | undefined): void { if (value !== undefined) this.validate(value); this.previewSetting = value; }
  validate(value: string): void {
    for (const name of themeSetting(value).split('/')) if (!this.catalog.has(name)) throw new Error(`Client theme '${name}' is unavailable.`);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.root !== undefined) {
      const root = await directory(this.root, false);
      if (root) {
        const themes = await directory(join(root, 'themes'), false);
        if (themes) {
          const files: string[] = [];
          for await (const entry of await opendir(themes)) {
            files.push(entry.name);
            if (files.length > 256) throw new Error('Client theme directory exceeds 256 entries.');
          }
          for (const file of files.sort()) {
            if (!file.endsWith('.json')) continue;
            try {
              const name = themeName(file.slice(0, -5));
              if (name === 'system') continue;
              const text = await readBounded(join(themes, file), THEME_BYTES);
              if (text !== undefined) this.catalog.set(name, parseClientTheme(text, name));
            } catch { this.notices.push(`Client theme file '${file}' is invalid or unsafe; it was not loaded.`); }
          }
        }
      }
    }
    await this.settings.load();
    this.loaded = true;
    try { this.validate(this.override ?? this.value); }
    catch (error) { this.notices.push(`${error instanceof Error ? error.message : String(error)} The saved name is retained; displaying felan-dark until corrected.`); }
  }

  async update(value: string): Promise<void> {
    await this.load(); this.validate(value);
    await this.settings.update({ theme: value });
  }
}
