const PI_SESSION_RENAME_KEYBINDING = 'app.session.rename';
const PROMPT_HISTORY_SHORTCUT = 'ctrl+r';
const installedKeybindingOverrides = new WeakSet<object>();

type KeybindingValue = string | readonly string[] | undefined;

interface MutableKeybindings {
  getUserBindings(): Readonly<Record<string, KeybindingValue>>;
  setUserBindings(bindings: Record<string, string | string[] | undefined>): void;
}

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

function isMutableKeybindings(value: unknown): value is MutableKeybindings & object {
  return typeof value === 'object'
    && value !== null
    && typeof Reflect.get(value, 'getUserBindings') === 'function'
    && typeof Reflect.get(value, 'setUserBindings') === 'function';
}
