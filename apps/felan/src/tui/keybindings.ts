import { Key, KeybindingsManager, TUI_KEYBINDINGS, type KeybindingsConfig } from '@earendil-works/pi-tui';
import { parseSchema, TuiKeybindingsSchema } from '@felan-ai/session-protocol';

const namedKeys = new Set(Object.values(Key).flatMap(value => typeof value === 'string' ? [value.toLowerCase()] : []));

export function parseClientKeybindings(value: unknown): KeybindingsConfig {
  const bindings = parseSchema(TuiKeybindingsSchema, value);
  for (const [action, binding] of Object.entries(bindings)) {
    for (const key of typeof binding === 'string' ? [binding] : binding) {
      const modifiers = key.match(/^(?:(?:ctrl|shift|alt|super)\+)*/u)?.[0] ?? '';
      const parts = modifiers.split('+').filter(Boolean);
      const base = key.slice(modifiers.length);
      if (new Set(parts).size !== parts.length || !(/^[a-z0-9]$/u.test(base) || namedKeys.has(base.toLowerCase()))) {
        throw new Error(`Invalid keybinding for ${action}: ${key}`);
      }
    }
  }
  return bindings as KeybindingsConfig;
}

export function createClientKeybindings(bindings: KeybindingsConfig = {}): KeybindingsManager & { reload(): void; getEffectiveConfig(): KeybindingsConfig } {
  const manager = new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    'app.interrupt': { defaultKeys: 'escape' },
    'app.clear': { defaultKeys: 'ctrl+c' },
    'app.exit': { defaultKeys: 'ctrl+d' },
    'app.tools.expand': { defaultKeys: 'ctrl+o' },
    'app.thinking.toggle': { defaultKeys: 'ctrl+t' },
    'app.thinking.cycle': { defaultKeys: 'shift+tab' },
    'app.model.select': { defaultKeys: 'ctrl+l' },
    'app.model.cycleForward': { defaultKeys: 'ctrl+p' },
    'app.model.cycleBackward': { defaultKeys: ['alt+p', 'shift+ctrl+p'] },
    'app.message.followUp': { defaultKeys: ['alt+enter', 'ctrl+q'] },
    'app.session.toggleNamedFilter': { defaultKeys: 'ctrl+n' },
    'app.session.togglePath': { defaultKeys: 'ctrl+p' },
    'app.session.toggleSort': { defaultKeys: 'ctrl+s' },
    'app.session.rename': { defaultKeys: 'ctrl+r' },
    'app.session.delete': { defaultKeys: 'ctrl+d' },
    'app.session.deleteNoninvasive': { defaultKeys: 'ctrl+backspace' },
    'app.session.new': { defaultKeys: [] },
    'app.session.tree': { defaultKeys: [] },
    'app.session.fork': { defaultKeys: [] },
    'app.session.resume': { defaultKeys: [] },
  }, bindings);
  return Object.assign(manager, { reload: () => manager.setUserBindings(manager.getUserBindings()), getEffectiveConfig: () => manager.getResolvedBindings() });
}
