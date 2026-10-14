import { Input, Key, getKeybindings, matchesKey, truncateToWidth, type Component, type Focusable, type Keybinding } from '@earendil-works/pi-tui';
import { copyToClipboard, type Theme } from '@earendil-works/pi-coding-agent';
import type { OperationResult } from '@felan-ai/session-protocol';
import type { NavigationDialogs } from './session-navigator.js';
import { defaultClientTheme } from './theme.js';
import { uiText } from '../client/ui.js';

type Tree = OperationResult<'session.tree'>;
type Entry = Tree['entries'][number];
type Filter = 'default' | 'noTools' | 'userOnly' | 'labeledOnly' | 'all';
export type TreeSelection = { action: 'select'; entryId: string } | { action: 'label'; entryId: string; label: string };
const filters: Filter[] = ['default', 'noTools', 'userOnly', 'labeledOnly', 'all'];
const metadata = new Set(['label', 'context_edit', 'custom', 'model_change', 'thinking_level_change', 'session_info', 'usage']);

export class TreeNavigator implements Component, Focusable {
  private readonly search = new Input();
  private readonly entries: Map<string, Entry>;
  private readonly active = new Set<string>();
  private readonly folded = new Set<string>();
  private selected: string | undefined;
  private filter: Filter = 'default';
  private editing: Input | undefined;
  private status = '';
  private readonly theme: () => Theme;

  constructor(private readonly tree: Tree, private readonly done: (selection: TreeSelection | undefined) => void,
    theme?: () => Theme, selected = tree.branch, private readonly copy: (text: string) => Promise<void> = copyToClipboard,
    private readonly requestRender: () => void = () => {}) {
    const initial = theme ? undefined : defaultClientTheme(); this.theme = theme ?? (() => initial!);
    this.entries = new Map(tree.entries.map(entry => [entry.id, entry])); this.selected = selected;
    for (let entry = this.entries.get(tree.branch); entry && !this.active.has(entry.id); entry = entry.parent ? this.entries.get(entry.parent) : undefined) this.active.add(entry.id);
    this.focused = true;
  }

  get focused(): boolean { return this.editing?.focused ?? this.search.focused; }
  set focused(value: boolean) { this.search.focused = value && !this.editing; if (this.editing) this.editing.focused = value; }
  invalidate(): void { this.search.invalidate(); this.editing?.invalidate(); }

  private rows(): Array<{ entry: Entry; parent: string | undefined; prefix: string }> {
    const query = this.search.getValue().toLowerCase().trim().split(/\s+/u).filter(Boolean);
    const visible = new Map(this.tree.entries.filter(entry => {
      if (entry.kind === 'usage') return false;
      if (this.filter === 'labeledOnly' && !entry.label) return false;
      if (this.filter === 'userOnly' && entry.role !== 'user') return false;
      if ((this.filter === 'default' || this.filter === 'noTools') && metadata.has(entry.kind)) return false;
      if (this.filter === 'noTools' && (entry.role === 'tool' || entry.role === 'toolResult')) return false;
      if (this.filter !== 'all' && entry.role === 'assistant' && !entry.summary.trim() && entry.id !== this.tree.branch) return false;
      return query.every(token => `${entry.label ?? ''} ${entry.role ?? entry.kind} ${entry.summary}`.toLowerCase().includes(token));
    }).map(entry => [entry.id, entry]));
    const children = new Map<string | undefined, Entry[]>();
    for (const entry of visible.values()) {
      let parent = entry.parent; const seen = new Set([entry.id]);
      while (parent && !seen.has(parent) && !visible.has(parent)) { seen.add(parent); parent = this.entries.get(parent)?.parent; }
      if (parent && seen.has(parent)) parent = undefined;
      children.set(parent, [...(children.get(parent) ?? []), entry]);
    }
    const result: Array<{ entry: Entry; parent: string | undefined; prefix: string }> = [];
    const roots = children.get(undefined) ?? [];
    const stack = [...roots].reverse().map(entry => ({ entry, parent: undefined as string | undefined, prefix: '' }));
    const visited = new Set<string>();
    while (stack.length) {
      const row = stack.pop()!; if (visited.has(row.entry.id)) continue; visited.add(row.entry.id); result.push(row);
      if (this.folded.has(row.entry.id)) continue;
      const descendants = [...(children.get(row.entry.id) ?? [])].sort((a, b) => Number(this.active.has(b.id)) - Number(this.active.has(a.id)));
      for (let i = descendants.length - 1; i >= 0; i--) stack.push({ entry: descendants[i]!, parent: row.entry.id,
        prefix: descendants.length > 1 ? `${row.prefix.replace(/[├└]─ $/u, '   ')}${i === descendants.length - 1 ? '└' : '├'}─ ` : row.prefix });
    }
    return result;
  }

  private selection(rows = this.rows()): number {
    let id = this.selected; const seen = new Set<string>();
    while (id && !seen.has(id)) {
      seen.add(id); const index = rows.findIndex(row => row.entry.id === id);
      if (index >= 0) return index;
      id = this.entries.get(id)?.parent;
    }
    return Math.max(0, rows.length - 1);
  }

  render(width: number): string[] {
    const rows = this.rows(); const index = this.selection(rows); const theme = this.theme(); const keys = getKeybindings();
    const key = (action: Keybinding) => keys.getKeys(action)[0] || 'unbound';
    const lines = [theme.fg('accent', theme.bold('Session Tree')),
      theme.fg('dim', `↑/↓ move · ←/→ page · ${key('app.tree.foldOrUp')}/${key('app.tree.unfoldOrDown')} branch · Enter navigate · Esc cancel`),
      theme.fg('dim', `${key('app.message.copy')} copy text preview · ${key('app.tree.editLabel')} label · Filter: ${this.filter}`),
      theme.fg('dim', `Filters: ${filters.slice(0, 3).map(filter => `${key(`app.tree.filter.${filter}`)} ${filter}`).join(' · ')}`),
      theme.fg('dim', `${filters.slice(3).map(filter => `${key(`app.tree.filter.${filter}`)} ${filter}`).join(' · ')} · ${key('app.tree.filter.cycleForward')}/${key('app.tree.filter.cycleBackward')} cycle`),
      `Type to search: ${this.search.render(Math.max(1, width - 16))[0] ?? ''}`, ''];
    const count = this.editing ? 8 : 10; const first = Math.max(0, index - Math.floor(count / 2));
    for (const [offset, row] of rows.slice(first, first + count).entries()) {
      const entry = row.entry;
      const role = entry.kind === 'message' ? `${entry.role === 'toolResult' ? 'tool' : entry.role ?? 'message'}: ` : entry.kind === 'custom_message' ? '' : `[${entry.kind}]: `;
      const text = truncateToWidth(`${first + offset === index ? '›' : ' '} ${row.prefix}${entry.id === this.tree.branch ? '◉' : this.active.has(entry.id) ? '•' : '○'} ${this.folded.has(entry.id) ? '▸ ' : ''}${entry.label ? `[${uiText(entry.label).replace(/\s+/gu, ' ')}] ` : ''}${role}${uiText(entry.summary).replace(/\s+/gu, ' ')}`, width);
      lines.push(first + offset === index ? theme.fg('accent', theme.bold(text)) : text);
    }
    if (!rows.length) lines.push(theme.fg('dim', this.tree.entries.length ? 'No matching entries.' : 'No conversation entries yet.'));
    else lines.push(theme.fg('dim', `(${index + 1}/${rows.length}) · ◉ current leaf · • active branch`));
    if (this.editing) lines.push('Label (empty clears; Enter saves, Esc cancels):', ...this.editing.render(width));
    if (this.status) lines.push(uiText(this.status));
    return lines.map(line => truncateToWidth(line, width));
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    if (this.editing) {
      if (keys.matches(data, 'tui.select.cancel')) { this.editing = undefined; this.search.focused = true; } else this.editing.handleInput(data);
      return;
    }
    const rows = this.rows(); let index = this.selection(rows); const selected = rows[index];
    if (keys.matches(data, 'tui.select.cancel')) { this.done(undefined); return; }
    if (keys.matches(data, 'tui.select.confirm')) { if (selected) this.done({ action: 'select', entryId: selected.entry.id }); return; }
    if (keys.matches(data, 'app.tree.editLabel') && selected) {
      this.editing = new Input(); this.editing.setValue(selected.entry.label ?? ''); this.search.focused = false; this.editing.focused = true;
      this.editing.onSubmit = label => this.done({ action: 'label', entryId: selected.entry.id, label }); return;
    }
    if (keys.matches(data, 'app.message.copy') && selected) {
      this.status = 'Copying text preview…';
      void this.copy(selected.entry.summary).then(() => { this.status = 'Text preview copied.'; }, () => { this.status = 'Clipboard unavailable.'; })
        .finally(() => this.requestRender()); return;
    }
    const filter = filters.find(value => keys.matches(data, `app.tree.filter.${value}`));
    if (filter) this.filter = filter;
    else if (keys.matches(data, 'app.tree.filter.cycleForward') || keys.matches(data, 'app.tree.filter.cycleBackward')) {
      this.filter = filters[(filters.indexOf(this.filter) + (keys.matches(data, 'app.tree.filter.cycleForward') ? 1 : filters.length - 1)) % filters.length]!;
    } else if (keys.matches(data, 'app.tree.foldOrUp') && selected) {
      if (rows.some(row => row.parent === selected.entry.id) && !this.folded.has(selected.entry.id)) this.folded.add(selected.entry.id);
      else this.selected = selected.parent ?? selected.entry.id;
      return;
    } else if (keys.matches(data, 'app.tree.unfoldOrDown') && selected) {
      if (this.folded.has(selected.entry.id)) this.folded.delete(selected.entry.id);
      else this.selected = rows.find(row => row.parent === selected.entry.id)?.entry.id ?? selected.entry.id;
      return;
    } else if (keys.matches(data, 'tui.select.up')) index = (index - 1 + rows.length) % rows.length;
    else if (keys.matches(data, 'tui.select.down')) index = (index + 1) % rows.length;
    else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.left)) index -= 12;
    else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.right)) index += 12;
    else { this.search.handleInput(data); return; }
    if (!filter && !keys.matches(data, 'app.tree.filter.cycleForward') && !keys.matches(data, 'app.tree.filter.cycleBackward')) this.selected = rows[Math.max(0, Math.min(rows.length - 1, index))]?.entry.id;
  }
}

export function pickTreeEntry(dialogs: NavigationDialogs, tree: Tree, theme?: () => Theme, selected?: string, requestRender?: () => void): Promise<TreeSelection | undefined> {
  if (!dialogs.custom) throw new Error('Tree navigation is unavailable in this client.');
  return dialogs.custom<TreeSelection | undefined>(done => new TreeNavigator(tree, done, theme, selected, undefined, requestRender));
}
