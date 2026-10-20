import { Key, KeybindingsManager, TUI_KEYBINDINGS, type KeybindingsConfig } from '@earendil-works/pi-tui';
import { parseSchema } from '@felan-ai/session-protocol';
import { TuiKeybindingsSchema } from './preferences-schema.js';

declare module '@earendil-works/pi-tui' {
  interface Keybindings {
    'app.tools.inspect': never;
    'app.history.search': never;
    'app.agents.open': never;
  }
}

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
    'app.tools.inspect': { defaultKeys: 'alt+t' },
    'app.history.search': { defaultKeys: ['ctrl+r', 'super+r'] },
    'app.agents.open': { defaultKeys: 'alt+a' },
    'app.thinking.toggle': { defaultKeys: 'ctrl+t' },
    'app.models.save': { defaultKeys: 'ctrl+s' },
    'app.thinking.save': { defaultKeys: 'ctrl+s' },
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
    'app.message.copy': { defaultKeys: 'ctrl+x' },
    'app.tree.foldOrUp': { defaultKeys: ['alt+left', 'ctrl+left'] },
    'app.tree.unfoldOrDown': { defaultKeys: ['alt+right', 'ctrl+right'] },
    'app.tree.editLabel': { defaultKeys: 'shift+l' },
    'app.tree.toggleLabelTimestamp': { defaultKeys: 'shift+t' },
    'app.tree.filter.default': { defaultKeys: 'ctrl+d' },
    'app.tree.filter.noTools': { defaultKeys: 'ctrl+t' },
    'app.tree.filter.userOnly': { defaultKeys: 'ctrl+u' },
    'app.tree.filter.labeledOnly': { defaultKeys: 'ctrl+l' },
    'app.tree.filter.all': { defaultKeys: 'ctrl+a' },
    'app.tree.filter.cycleForward': { defaultKeys: 'ctrl+o' },
    'app.tree.filter.cycleBackward': { defaultKeys: 'shift+ctrl+o' },
    'app.session.new': { defaultKeys: [] },
    'app.session.tree': { defaultKeys: [] },
    'app.session.fork': { defaultKeys: [] },
    'app.session.resume': { defaultKeys: [] },
  }, bindings);
  return Object.assign(manager, { reload: () => manager.setUserBindings(manager.getUserBindings()), getEffectiveConfig: () => manager.getResolvedBindings() });
}

export const CLIENT_KEYBINDING_LABELS: Record<string, string> = {
  'app.interrupt': 'Interrupt the current operation',
  'app.clear': 'Clear input (press twice to exit)',
  'app.exit': 'Exit with an empty editor',
  'app.tools.expand': 'Expand or collapse tool output',
  'app.tools.inspect': 'Open tool activity',
  'app.history.search': 'Search prompt history',
  'app.agents.open': 'Open the subagent navigator',
  'app.thinking.toggle': 'Show or hide thinking',
  'app.models.save': 'Set the default model',
  'app.thinking.save': 'Set the default thinking level',
  'app.thinking.cycle': 'Cycle thinking level',
  'app.model.select': 'Select a model',
  'app.model.cycleForward': 'Cycle to the next model',
  'app.model.cycleBackward': 'Cycle to the previous model',
  'app.message.followUp': 'Queue a follow-up message',
  'app.message.copy': 'Copy message text',
  'app.session.toggleNamedFilter': 'Show named sessions only',
  'app.session.togglePath': 'Show session paths',
  'app.session.toggleSort': 'Change session sort order',
  'app.session.rename': 'Rename the selected session',
  'app.session.delete': 'Delete the selected closed session',
  'app.session.deleteNoninvasive': 'Delete the selected closed session',
  'app.tree.foldOrUp': 'Fold branch or move to parent',
  'app.tree.unfoldOrDown': 'Unfold branch or move to child',
  'app.tree.editLabel': 'Edit tree entry label',
  'app.tree.toggleLabelTimestamp': 'Toggle tree label timestamps',
  'app.tree.filter.default': 'Show default tree entries',
  'app.tree.filter.noTools': 'Hide tool entries',
  'app.tree.filter.userOnly': 'Show user messages only',
  'app.tree.filter.labeledOnly': 'Show labeled entries only',
  'app.tree.filter.all': 'Show all tree entries',
  'app.tree.filter.cycleForward': 'Cycle to the next tree filter',
  'app.tree.filter.cycleBackward': 'Cycle to the previous tree filter',
  'app.session.new': 'Start a new session',
  'app.session.tree': 'Navigate the session tree',
  'app.session.fork': 'Fork the session',
  'app.session.resume': 'Resume a session',
};
