import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { TuiKeybindingsSchema, TuiPreferencesSchema, TuiPreferencesUpdateSchema, parseSchema, type TuiPreferences, type TuiPreferencesUpdate } from '@felan-ai/session-protocol';
import { mergeDaemonGlobalSettings, readDaemonGlobalSettings } from './global-settings.js';

export class DaemonTuiPreferences {
  constructor(private readonly options: { agentDir: string; assertCurrent(): void }) {}

  async get(): Promise<TuiPreferences> {
    const settings = await readDaemonGlobalSettings(this.options.agentDir, this.options.assertCurrent);
    const terminal = object(settings.terminal, 'terminal'); const tui = object(settings.felanTui, 'felanTui');
    const keybindings = { ...await this.legacyKeybindings(), ...parseSchema(TuiKeybindingsSchema, tui.keybindings ?? {}) };
    this.options.assertCurrent();
    return parseSchema(TuiPreferencesSchema, { hideThinking: settings.hideThinkingBlock ?? false,
      showImages: terminal.showImages ?? true, imageWidthCells: terminal.imageWidthCells ?? 60, outputPad: settings.outputPad ?? 1,
      toolDisplay: tui.toolDisplay ?? 'grouped', keybindings });
  }

  async set(value: TuiPreferencesUpdate): Promise<void> {
    const preferences = parseSchema(TuiPreferencesUpdateSchema, value);
    await mergeDaemonGlobalSettings(this.options.agentDir, { extensions: [], preferences }, this.options.assertCurrent);
  }

  private async legacyKeybindings(): Promise<TuiPreferences['keybindings']> {
    this.options.assertCurrent();
    let file;
    try { file = await open(join(this.options.agentDir, 'keybindings.json'), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.size > 64 * 1024) throw new Error('Unsafe or oversized keybindings file.');
      const data = Buffer.alloc(64 * 1024 + 1); let size = 0;
      while (size < data.length) {
        const result = await file.read(data, size, data.length - size, size);
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      if (size > 64 * 1024) throw new Error('Keybindings file exceeds its size limit.');
      return parseSchema(TuiKeybindingsSchema, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, size))));
    } finally { await file.close(); }
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  return value as Record<string, unknown>;
}
