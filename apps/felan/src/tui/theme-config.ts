import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { TerminalColors } from '@earendil-works/pi-tui';
import { bundledClientThemes, parseClientTheme, systemClientTheme, themeName, themeSetting, THEME_BYTES } from './theme.js';

const SETTINGS_BYTES = 256 * 1024;

export class ClientThemes {
  private catalog = bundledClientThemes();
  private setting = 'felan-dark';
  private previewSetting: string | undefined;
  private terminalColors: TerminalColors = {};
  private appearance: 'dark' | 'light';
  private loaded = false;
  private notices: string[] = [];

  constructor(private readonly root?: string, private readonly override?: string, appearance?: 'dark' | 'light') {
    this.appearance = appearance ?? (/^(?:[^;]*;)*(?:7|9|1[0-5])$/u.test(process.env.COLORFGBG ?? '') ? 'light' : 'dark');
    if (override !== undefined) themeSetting(override);
  }
  get value(): string { return this.setting; }
  get theme(): Theme {
    const names = (this.previewSetting ?? this.override ?? this.setting).split('/');
    const selected = names.length === 2 ? names[this.appearance === 'light' ? 0 : 1]! : names[0]!;
    return this.catalog.get(selected) ?? this.catalog.get('felan-dark')!;
  }
  get warnings(): readonly string[] { return this.notices; }
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
        const local = await directory(join(root, 'tui'), false);
        const settings = local ? await readBounded(join(local, 'settings.json'), SETTINGS_BYTES) : undefined;
        const legacy = settings === undefined ? await readBounded(join(root, 'settings.json'), SETTINGS_BYTES) : undefined;
        if (settings !== undefined || legacy !== undefined) {
          const value: unknown = JSON.parse(settings ?? legacy!);
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid client theme settings.');
          const name = (value as Record<string, unknown>).theme;
          if (name !== undefined) this.setting = themeSetting(name);
        }
      }
    }
    this.loaded = true;
    try { this.validate(this.override ?? this.setting); }
    catch (error) { this.notices.push(`${error instanceof Error ? error.message : String(error)} The saved name is retained; displaying felan-dark until corrected.`); }
  }

  async update(value: string): Promise<void> {
    await this.load(); this.validate(value);
    if (this.root !== undefined) {
      const root = await directory(this.root, true);
      const local = await directory(join(root!, 'tui'), true);
      const file = join(local!, 'settings.json');
      const previous = await readBounded(file, SETTINGS_BYTES);
      const document: unknown = previous === undefined ? {} : JSON.parse(previous);
      if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('Invalid client theme settings.');
      const contents = `${JSON.stringify({ ...document, theme: value }, null, 2)}\n`;
      if (Buffer.byteLength(contents) > SETTINGS_BYTES) throw new Error('Client settings exceed their size limit.');
      const temporary = join(local!, `.settings-${randomUUID()}.tmp`);
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(contents, 'utf8'); await handle.sync(); await handle.close();
        if (await directory(join(root!, 'tui'), false) !== local) throw new Error('Client configuration directory changed.');
        await readBounded(file, SETTINGS_BYTES);
        await rename(temporary, file);
      } finally { await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
    }
    this.setting = value;
  }
}

async function directory(path: string, create: boolean): Promise<string | undefined> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
  if (!stat) return undefined;
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw new Error('Unsafe client configuration directory.');
  return realpath(resolve(path));
}

async function readBounded(path: string, limit: number): Promise<string | undefined> {
  if (await directory(dirname(path), false) !== resolve(dirname(path))) throw new Error('Client configuration directory changed.');
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.size > limit) throw new Error('Unsafe or oversized client theme file.');
    const bytes = Buffer.alloc(limit + 1); let size = 0;
    while (size < bytes.length) { const read = await file.read(bytes, size, bytes.length - size, size); if (!read.bytesRead) break; size += read.bytesRead; }
    if (size > limit) throw new Error('Client theme file exceeds its size limit.');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
  } finally { await file.close(); }
}
