import { migrateSessionEntries, parseSessionEntries, type FileEntry } from '@earendil-works/pi-coding-agent';
import type {
  PromptHistoryHost,
  PromptHistorySession,
  PromptHistorySessionReference,
} from '@felan-ai/ext-prompt-history';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

const MAX_SESSION_FILE_BYTES = 4 * 1024 * 1024;
const PI_SESSION_RENAME_KEYBINDING = 'app.session.rename';
const PROMPT_HISTORY_SHORTCUT = 'ctrl+r';
const installedKeybindingOverrides = new WeakSet<object>();

type KeybindingValue = string | readonly string[] | undefined;

interface MutableKeybindings {
  getUserBindings(): Readonly<Record<string, KeybindingValue>>;
  setUserBindings(bindings: Record<string, string | string[] | undefined>): void;
}

export const localPromptHistoryHost: PromptHistoryHost = {
  listSessions: listLocalPromptHistorySessions,
  readSession: readLocalPromptHistorySession,
};

export function installPromptHistoryKeybindingOverride(mode: object): void {
  const keybindings = Reflect.get(mode, 'keybindings') as unknown;
  if (!isMutableKeybindings(keybindings) || installedKeybindingOverrides.has(keybindings)) return;
  installedKeybindingOverrides.add(keybindings);

  removePromptHistoryShortcutFromSessionRename(keybindings);
  const reload = Reflect.get(keybindings, 'reload');
  if (typeof reload !== 'function') return;
  Reflect.set(keybindings, 'reload', () => {
    Reflect.apply(reload, keybindings, []);
    removePromptHistoryShortcutFromSessionRename(keybindings);
  });
}

export function removePromptHistoryShortcutFromSessionRename(keybindings: MutableKeybindings): void {
  const userBindings = keybindings.getUserBindings();
  const configured = userBindings[PI_SESSION_RENAME_KEYBINDING];
  if (configured !== undefined) {
    const keys = Array.isArray(configured) ? configured : [configured];
    const filtered = keys.filter((key) => key.toLowerCase() !== PROMPT_HISTORY_SHORTCUT);
    if (filtered.length === keys.length) return;
    keybindings.setUserBindings({
      ...userBindings,
      [PI_SESSION_RENAME_KEYBINDING]: filtered,
    });
    return;
  }

  keybindings.setUserBindings({
    ...userBindings,
    [PI_SESSION_RENAME_KEYBINDING]: [],
  });
}

async function listLocalPromptHistorySessions(
  sessionDirectory: string,
): Promise<readonly PromptHistorySessionReference[]> {
  try {
    const entries = await readdir(sessionDirectory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => ({
        id: join(sessionDirectory, entry.name),
        label: entry.name,
        timestamp: sessionDateFromFileName(entry.name),
      }));
  } catch {
    return [];
  }
}

async function readLocalPromptHistorySession(
  reference: PromptHistorySessionReference,
): Promise<PromptHistorySession | undefined> {
  try {
    const file = await stat(reference.id);
    if (!file.isFile() || file.size > MAX_SESSION_FILE_BYTES) return undefined;
    const entries = parseSessionEntries(await readFile(reference.id, 'utf8'));
    migrateSessionEntries(entries);
    const header = entries.find((entry) => entry.type === 'session');
    if (!header) return undefined;
    const sessionEntries = entries.filter((entry): entry is Exclude<FileEntry, { type: 'session' }> => entry.type !== 'session');
    const name = [...sessionEntries]
      .reverse()
      .find((entry) => entry.type === 'session_info')?.name?.trim() || undefined;
    return {
      cwd: header?.cwd ?? '',
      ...(name === undefined ? {} : { name }),
      entries: sessionEntries,
    };
  } catch {
    return undefined;
  }
}

function sessionDateFromFileName(name: string): number {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/u.exec(basename(name));
  const timestamp = match?.[1]?.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/u, 'T$1:$2:$3.$4Z');
  const time = timestamp === undefined ? NaN : new Date(timestamp).getTime();
  return Number.isFinite(time) ? time : 0;
}

function isMutableKeybindings(value: unknown): value is MutableKeybindings & object {
  return typeof value === 'object'
    && value !== null
    && typeof Reflect.get(value, 'getUserBindings') === 'function'
    && typeof Reflect.get(value, 'setUserBindings') === 'function';
}
