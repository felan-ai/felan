import { Key, matchesKey, Text, TUI_KEYBINDINGS, type Component, type KeybindingsManager, type SlashCommand } from '@earendil-works/pi-tui';
import { uiText } from '../client/ui.js';
import { CLIENT_KEYBINDING_LABELS } from './keybindings.js';

export function commandHelp(keys: KeybindingsManager, commands: readonly SlashCommand[]): string {
  const displayKey = (key: string) => key.split('+').map(part => ({ alt: 'Option', ctrl: 'Ctrl', super: 'Cmd', shift: 'Shift',
    pageUp: 'PageUp', pageDown: 'PageDown', escape: 'Esc', up: '↑', down: '↓', left: '←', right: '→' }[part] ?? part[0]!.toUpperCase() + part.slice(1))).join('+');
  const definitions: Record<string, { description?: string }> = TUI_KEYBINDINGS;
  const shortcuts = Object.entries(keys.getResolvedBindings()).sort(([a], [b]) => Number(b.startsWith('app.')) - Number(a.startsWith('app.')))
    .flatMap(([action, binding]) => {
      const names = typeof binding === 'string' ? [binding] : binding ?? [];
      const label = CLIENT_KEYBINDING_LABELS[action] ?? definitions[action]?.description;
      const context = action.startsWith('app.tree.') ? 'Tree navigator'
        : action.startsWith('app.session.') ? 'Session navigator'
        : action === 'app.models.save' ? 'Model picker'
        : action === 'app.thinking.save' ? 'Thinking picker' : 'Global / editor';
      return names.length && label ? [[names.map(displayKey).join(' / '), label, context]] : [];
    });
  shortcuts.push(['/', 'Slash commands', 'Global / editor'], ['!', 'Shell command', 'Global / editor'], ['!!', 'Shell command without context', 'Global / editor']);
  const width = Math.max(...shortcuts.map(([key]) => key!.length));
  const contexts = ['Global / editor', 'Session navigator', 'Tree navigator', 'Model picker', 'Thinking picker'];
  return ['Keyboard Shortcuts', ...contexts.flatMap(context => ['', context,
    ...shortcuts.filter(row => row[2] === context).map(([key, label]) => `${key!.padEnd(width)} │ ${label}`)]),
    '', 'Commands', ...commands.map(command => `/${command.name} — ${command.description ?? ''}`)].join('\n');
}

export class CommandHelp implements Component {
  private offset = 0;
  constructor(private readonly text: string, private readonly requestRender: () => void, private readonly close: () => void) {}
  render(width: number): string[] {
    const lines = new Text(uiText(this.text), 1, 1).render(width);
    this.offset = Math.min(this.offset, Math.max(0, lines.length - 18));
    return ['Help · ↑↓ scroll · PgUp/PgDn page · Esc close', ...lines.slice(this.offset, this.offset + 18)];
  }
  invalidate(): void {}
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) { this.close(); return; }
    if (matchesKey(data, Key.up)) this.offset = Math.max(0, this.offset - 1);
    if (matchesKey(data, Key.down)) this.offset++;
    if (matchesKey(data, Key.pageUp)) this.offset = Math.max(0, this.offset - 16);
    if (matchesKey(data, Key.pageDown)) this.offset += 16;
    this.requestRender();
  }
}
