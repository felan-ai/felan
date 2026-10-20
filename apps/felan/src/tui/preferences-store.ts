import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { Type } from 'typebox';
import { assertJson, parseSchema } from '@felan-ai/session-protocol';
import { TuiPreferencesSchema, defaultPresentationPreferences, validatePresentationPreferences, type TuiPreferences, type TuiPreferencesUpdate } from './preferences-schema.js';
import { parseClientKeybindings } from './keybindings.js';
import { themeSetting } from './theme.js';

const SETTINGS_BYTES = 256 * 1024;
const SettingsSchema = Type.Partial(Type.Object({ ...TuiPreferencesSchema.properties, presentation: Type.Unknown(), theme: Type.String() }), { additionalProperties: false });
export type ClientTuiSettings = TuiPreferences & { theme: string };
const defaults: ClientTuiSettings = { presentation: structuredClone(defaultPresentationPreferences), theme: 'felan-dark', hideThinking: false, showImages: true, imageWidthCells: 60, outputPad: 1,
  toolDisplay: 'grouped', keybindings: {}, hardwareCursor: false, clearOnShrink: false, terminalProgress: false, editorPadding: 1,
  autocompleteMaxVisible: 5, mermaid: 'streaming', quietStartup: false, fullscreenScrollbar: 'auto', fullscreenCopyOnSelect: true, fullscreenWheelScrollLines: 'auto' };

export class ClientPreferencesStore {
  private stored = structuredClone(defaults);
  private skippedLegacy = false;
  private loaded = false;
  constructor(readonly root?: string) {}
  get values(): ClientTuiSettings { return structuredClone(this.stored); }
  get warnings(): readonly string[] { return this.skippedLegacy ? ['Invalid legacy display preferences were skipped; valid preferences were retained.'] : []; }

  async load(): Promise<void> { this.stored = this.read().values; this.loaded = true; }

  async update(update: TuiPreferencesUpdate & { theme?: string }): Promise<void> {
    const patch = validateSettings(update);
    if (this.root !== undefined) {
      const root = directorySync(this.root, true)!;
      const local = directorySync(join(root, 'tui'), true)!;
      // Keep the bounded read/merge/rename together, with no asynchronous gap between concurrent stores.
      const { values, document } = this.read();
      const changed = { ...patch, ...(patch.presentation ? { presentation: changedFields(this.loaded ? this.stored : values, patch).presentation } : {}) };
      const next = mergeFields(values, changed) as ClientTuiSettings;
      const contents = `${JSON.stringify({ ...document, ...next }, null, 2)}\n`;
      if (Buffer.byteLength(contents) > SETTINGS_BYTES) throw new Error('Client settings exceed their size limit.');
      const temporary = join(local, `.settings-${randomUUID()}.tmp`);
      const handle = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        writeFileSync(handle, contents, 'utf8'); fsyncSync(handle);
        if (directorySync(join(root, 'tui'), false) !== local) throw new Error('Client configuration directory changed.');
        renameSync(temporary, join(local, 'settings.json'));
        const parent = openSync(local, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { fsyncSync(parent); } finally { closeSync(parent); }
      } finally { closeSync(handle); try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
      this.stored = next;
    } else this.stored = { ...this.stored, ...patch };
    this.loaded = true;
  }

  private legacy<T>(read: () => T, fallback: T): T {
    try { return read(); } catch { this.skippedLegacy = true; return fallback; }
  }

  private read(): { values: ClientTuiSettings; document: Record<string, unknown> } {
    if (this.root === undefined) return { values: this.values, document: {} };
    const root = directorySync(this.root, false);
    if (!root) return { values: structuredClone(defaults), document: {} };
    const local = directorySync(join(root, 'tui'), false);
    const text = local ? readBoundedSync(join(local, 'settings.json'), SETTINGS_BYTES) : undefined;
    const document = text === undefined ? {} : object(JSON.parse(text));
    assertJson(document, SETTINGS_BYTES);
    const settings = validateSettings(Object.fromEntries(Object.entries(document).filter(([key]) => Object.hasOwn(SettingsSchema.properties, key) && key !== 'presentation')));
    const storedPresentation = object(document.presentation);
    for (const key of Object.keys(storedPresentation)) if (!Object.hasOwn(defaultPresentationPreferences, key)) throw new Error(`Unknown presentation preference: ${key}`);
    const presentation = structuredClone(defaultPresentationPreferences);
    const needsLegacyPresentation = Object.entries(presentation).some(([id, fields]) => {
      const local = object(storedPresentation[id]);
      return Object.keys(fields).some(key => !Object.hasOwn(local, key));
    });
    const needsLegacy = Object.keys(defaults).some(key => key !== 'presentation' && !Object.hasOwn(settings, key)) || needsLegacyPresentation;
    const old = needsLegacy ? this.legacy(() => {
      const previous = readBoundedSync(join(root, 'settings.json'), SETTINGS_BYTES);
      return previous === undefined ? {} : object(JSON.parse(previous));
    }, {}) : {};
    const legacy: Record<string, unknown> = {};
    if (needsLegacy) {
      const terminal = this.legacy(() => object(old.terminal), {});
      const tui = this.legacy(() => object(old.felanTui), {});
      const markdown = this.legacy(() => object(old.markdown), {});
      const fields: Record<string, unknown> = { theme: old.theme, hideThinking: old.hideThinkingBlock, showImages: terminal.showImages,
        imageWidthCells: terminal.imageWidthCells, outputPad: old.outputPad, toolDisplay: tui.toolDisplay, mermaid: markdown.mermaid,
        hardwareCursor: old.showHardwareCursor, editorPadding: old.editorPaddingX, autocompleteMaxVisible: old.autocompleteMaxVisible,
        clearOnShrink: terminal.clearOnShrink, terminalProgress: terminal.showTerminalProgress,
        ...Object.fromEntries(['quietStartup', 'fullscreenScrollbar', 'fullscreenCopyOnSelect', 'fullscreenWheelScrollLines'].map(key => [key, old[key]])) };
      for (const [key, value] of Object.entries(fields)) if (value !== undefined && !Object.hasOwn(settings, key)) {
        Object.assign(legacy, this.legacy(() => validateSettings({ [key]: value }), {}));
      }
      if (settings.keybindings === undefined) {
        const bindings = this.legacy(() => {
          const keys = readBoundedSync(join(root, 'keybindings.json'), 64 * 1024);
          return keys === undefined ? {} : object(JSON.parse(keys));
        }, {});
        let combined: Record<string, unknown> = {};
        for (const source of [bindings, this.legacy(() => object(tui.keybindings), {})]) {
          for (const [key, value] of Object.entries(source)) combined = this.legacy(() => parseClientKeybindings({ ...combined, [key]: value }), combined);
        }
        legacy.keybindings = combined;
      }
    }
    const oldExtensions = needsLegacyPresentation ? this.legacy(() => object(old.extensionConfig), {}) : {};
    for (const id of ['askUser', 'tasks', 'promptHistory', 'contextView', 'powerline'] as const) {
      const local = object(storedPresentation[id]);
      const allowed = defaultPresentationPreferences[id];
      const old = this.legacy(() => object(id === 'contextView' ? oldExtensions['context-view'] ?? oldExtensions.contextView : oldExtensions[id]), {});
      for (const [key, raw] of Object.entries(old)) {
        if (!Object.hasOwn(allowed, key) || Object.hasOwn(local, key)) continue;
        this.legacy(() => {
          let value = raw;
          if (id === 'powerline' && key === 'lines' && Array.isArray(value)) value = value.map(line => ({
            segments: Object.fromEntries(Object.entries(object(object(line).segments)).map(([name, fields]) => [name,
              Object.fromEntries(Object.entries(object(fields)).filter(([field]) => !['showWorkingTree', 'showStashCount', 'periodDays', 'maxWindows'].includes(field)))])),
          }));
          const candidate = { ...presentation, [id]: { ...presentation[id], [key]: value } };
          presentation[id] = validatePresentationPreferences(candidate)[id] as never;
        }, undefined);
      }
      Object.assign(presentation[id], local);
    }
    return { values: { ...defaults, ...legacy, ...settings, presentation: validatePresentationPreferences(presentation) } as ClientTuiSettings, document };
  }
}

function validateSettings(value: unknown): TuiPreferencesUpdate & { theme?: string } {
  const settings = parseSchema(SettingsSchema, value);
  const { presentation, ...rest } = settings;
  if (settings.theme !== undefined) themeSetting(settings.theme);
  if (settings.keybindings !== undefined) parseClientKeybindings(settings.keybindings);
  return { ...rest, ...(presentation === undefined ? {} : { presentation: validatePresentationPreferences(presentation) }) };
}

function changedFields(previous: object, patch: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).flatMap(([key, value]) => {
    const before = (previous as Record<string, unknown>)[key];
    // Presentation editors submit full sections; only their changed leaves should replace another client's edits.
    if (key === 'presentation') return [[key, Object.fromEntries(Object.entries(object(value)).map(([id, fields]) => [id, changedFields(object(object(before)[id]), object(fields))]))]];
    return JSON.stringify(before) !== JSON.stringify(value) ? [[key, value]] : [];
  }));
}

function mergeFields(previous: object, patch: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...previous };
  for (const [key, value] of Object.entries(patch)) result[key] = key === 'presentation'
    ? Object.fromEntries(Object.entries(object(result[key])).map(([id, fields]) => [id, { ...object(fields), ...object(object(value)[id]) }])) : value;
  return result;
}

function object(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Client settings must be an object.');
  return value as Record<string, unknown>;
}

export async function directory(path: string, create: boolean): Promise<string | undefined> { return directorySync(path, create); }
export async function readBounded(path: string, limit: number): Promise<string | undefined> { return readBoundedSync(path, limit); }
function statOrUndefined(path: string): Stats | undefined {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

function directorySync(path: string, create: boolean): string | undefined {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = statOrUndefined(path);
  if (!stat) return undefined;
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022)) throw new Error('Unsafe client configuration directory.');
  return realpathSync(resolve(path));
}

function readBoundedSync(path: string, limit: number): string | undefined {
  if (directorySync(dirname(path), false) !== resolve(dirname(path))) throw new Error('Client configuration directory changed.');
  let file;
  try { file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.size > limit) throw new Error('Unsafe or oversized client configuration file.');
    const bytes = Buffer.alloc(limit + 1); let size = 0;
    while (size < bytes.length) { const read = readSync(file, bytes, size, bytes.length - size, size); if (!read) break; size += read; }
    if (size > limit) throw new Error('Client configuration file exceeds its size limit.');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
  } finally { closeSync(file); }
}
