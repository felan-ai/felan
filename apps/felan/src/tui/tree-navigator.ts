import { Input, Text, getKeybindings, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type Keybinding } from '@earendil-works/pi-tui';
import { copyToClipboard, keyText, type Theme } from '@earendil-works/pi-coding-agent';
import type { OperationResult } from '@felan-ai/session-protocol';
import type { NavigationDialogs } from './session-navigator.js';
import { defaultClientTheme } from './theme.js';
import { uiText } from '../client/ui.js';

type Tree = OperationResult<'session.tree'>;
type Entry = Tree['entries'][number];
export type Filter = 'default' | 'noTools' | 'userOnly' | 'labeledOnly' | 'all';
type Gutter = { position: number; show: boolean };
type Layout = { indent: number; showConnector: boolean; isLast: boolean; gutters: Gutter[]; isVirtualRootChild: boolean };
type View = { entries: Entry[]; index: number; layout: Map<string, Layout>; parents: Map<string, string | null>; children: Map<string | null, string[]>; multipleRoots: boolean };
/** Navigator state that survives reopening the tree after a label edit. */
export type TreeViewState = { filter: Filter; query: string; folded: string[]; showLabelTimestamps: boolean };
export type TreeSelection = { action: 'select'; entryId: string } | { action: 'label'; entryId: string; label: string; view: TreeViewState };

const filters: Filter[] = ['default', 'noTools', 'userOnly', 'labeledOnly', 'all'];
const settingKinds = new Set(['label', 'context_edit', 'custom', 'model_change', 'thinking_level_change', 'session_info']);
const copyKinds = new Set(['message', 'custom_message', 'compaction', 'branch_summary']);
const chromeLines = 12;
const gutterWidth = 2;
const helpItems: Array<{ keys: Keybinding[]; label: string; labelFirst?: boolean }> = [
  { keys: ['tui.select.up', 'tui.select.down'], label: 'move' },
  { keys: ['tui.editor.cursorLeft', 'tui.editor.cursorRight'], label: 'page' },
  { keys: ['app.tree.foldOrUp', 'app.tree.unfoldOrDown'], label: 'branch' },
  { keys: ['app.message.copy'], label: 'copy' },
  { keys: ['app.tree.editLabel'], label: 'label' },
  { keys: ['app.tree.toggleLabelTimestamp'], label: 'label time' },
  { keys: ['app.tree.filter.default', 'app.tree.filter.noTools', 'app.tree.filter.userOnly', 'app.tree.filter.labeledOnly', 'app.tree.filter.all'], label: 'filters', labelFirst: true },
  { keys: ['app.tree.filter.cycleForward', 'app.tree.filter.cycleBackward'], label: 'cycle', labelFirst: true },
];

export class TreeNavigator implements Component, Focusable {
  private readonly entries: Map<string, Entry>;
  private readonly order: Entry[];
  private readonly active = new Set<string>();
  private readonly folded: Set<string>;
  private query: string;
  private selectedId: string | undefined;
  private filter: Filter;
  private showLabelTimestamps: boolean;
  private editing: { entryId: string; input: Input } | undefined;
  private status = '';
  private focusedState = true;
  private readonly theme: () => Theme;

  constructor(private readonly tree: Tree, private readonly done: (selection: TreeSelection | undefined) => void,
    theme?: () => Theme, selected = tree.branch, private readonly copy: (text: string) => Promise<void> = copyToClipboard,
    private readonly requestRender: () => void = () => {}, private readonly height: () => number = () => 24,
    view: TreeViewState = { filter: 'default', query: '', folded: [], showLabelTimestamps: false }) {
    const initial = theme ? undefined : defaultClientTheme(); this.theme = theme ?? (() => initial!);
    this.entries = new Map(tree.entries.map(entry => [entry.id, entry])); this.selectedId = selected;
    this.filter = view.filter; this.query = view.query; this.folded = new Set(view.folded); this.showLabelTimestamps = view.showLabelTimestamps;
    for (let entry = this.entries.get(tree.branch); entry && !this.active.has(entry.id); entry = entry.parent ? this.entries.get(entry.parent) : undefined) this.active.add(entry.id);
    this.order = this.preorder();
  }

  get focused(): boolean { return this.focusedState; }
  set focused(value: boolean) { this.focusedState = value; if (this.editing) this.editing.input.focused = value; }
  invalidate(): void { this.editing?.input.invalidate(); }

  /** Pi's pre-order: children on the active branch first, then the rest in stored order. */
  private preorder(): Entry[] {
    const children = new Map<string | undefined, Entry[]>();
    for (const entry of this.tree.entries) {
      const parent = this.parentId(entry.id);
      children.set(parent, [...(children.get(parent) ?? []), entry]);
    }
    const ordered = (list: Entry[] = []) => [...list.filter(entry => this.active.has(entry.id)), ...list.filter(entry => !this.active.has(entry.id))];
    const result: Entry[] = []; const stack = [...ordered(children.get(undefined))].reverse();
    while (stack.length) {
      const entry = stack.pop()!; result.push(entry);
      stack.push(...[...ordered(children.get(entry.id))].reverse());
    }
    return result;
  }

  private parentId(id: string): string | undefined {
    const parent = this.entries.get(id)?.parent;
    return parent !== undefined && this.entries.has(parent) ? parent : undefined;
  }

  private maxVisible(): number {
    const height = this.height();
    return Math.max(5, Math.min(Math.floor(height / 2), height - chromeLines));
  }

  private passesFilter(entry: Entry, query: string[]): boolean {
    if (entry.kind === 'usage') return false;
    const errorOrAborted = entry.stopReason !== undefined && entry.stopReason !== 'stop' && entry.stopReason !== 'toolUse';
    if (entry.kind === 'message' && entry.role === 'assistant' && entry.id !== this.tree.branch && !entry.summary.trim() && !errorOrAborted) return false;
    const passes = (() => {
      switch (this.filter) {
        case 'userOnly': return entry.kind === 'message' && entry.role === 'user';
        case 'noTools': return !settingKinds.has(entry.kind) && !(entry.kind === 'message' && entry.role === 'toolResult');
        case 'labeledOnly': return entry.label !== undefined;
        case 'all': return true;
        case 'default': return !settingKinds.has(entry.kind);
      }
    })();
    if (!passes) return false;
    const searchable = `${entry.label ?? ''} ${entry.role ?? entry.kind} ${entry.role === 'toolResult' ? '' : entry.title ?? ''} ${entry.summary}`.toLowerCase();
    return query.every(token => searchable.includes(token));
  }

  private view(): View {
    const query = this.query.toLowerCase().split(/\s+/u).filter(Boolean);
    const hidden = new Set<string>();
    for (const entry of this.order) {
      const parent = this.parentId(entry.id);
      if (parent !== undefined && (this.folded.has(parent) || hidden.has(parent))) hidden.add(entry.id);
    }
    const entries = this.order.filter(entry => !hidden.has(entry.id) && this.passesFilter(entry, query));
    const visible = new Set(entries.map(entry => entry.id));
    const parents = new Map<string, string | null>(); const children = new Map<string | null, string[]>([[null, []]]);
    for (const entry of entries) {
      let ancestor = this.parentId(entry.id);
      while (ancestor !== undefined && !visible.has(ancestor)) ancestor = this.parentId(ancestor);
      const parent = ancestor ?? null;
      parents.set(entry.id, parent); children.set(parent, [...(children.get(parent) ?? []), entry.id]);
    }
    const layout = new Map<string, Layout>();
    const roots = children.get(null) ?? [];
    const multipleRoots = roots.length > 1;
    const stack: Array<[string, number, boolean, boolean, boolean, Gutter[], boolean]> = [];
    for (let index = roots.length - 1; index >= 0; index--) stack.push([roots[index]!, multipleRoots ? 1 : 0, multipleRoots, multipleRoots, index === roots.length - 1, [], multipleRoots]);
    while (stack.length) {
      const [id, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!;
      layout.set(id, { indent, showConnector, isLast, gutters, isVirtualRootChild });
      const kids = children.get(id) ?? [];
      const multipleChildren = kids.length > 1;
      const childIndent = multipleChildren || (justBranched && indent > 0) ? indent + 1 : indent;
      const connectorDisplayed = showConnector && !isVirtualRootChild;
      const displayIndent = multipleRoots ? Math.max(0, indent - 1) : indent;
      const connectorPosition = Math.max(0, displayIndent - 1);
      const childGutters = connectorDisplayed ? [...gutters, { position: connectorPosition, show: !isLast }] : gutters;
      for (let index = kids.length - 1; index >= 0; index--) stack.push([kids[index]!, childIndent, multipleChildren, multipleChildren, index === kids.length - 1, childGutters, false]);
    }
    let index = Math.max(0, entries.length - 1);
    for (let id: string | undefined = this.selectedId; id !== undefined; id = this.parentId(id)) {
      const found = entries.findIndex(entry => entry.id === id);
      if (found >= 0) { index = found; break; }
    }
    return { entries, index: Math.max(0, index), layout, parents, children, multipleRoots };
  }

  private viewState(): TreeViewState {
    return { filter: this.filter, query: this.query, folded: [...this.folded], showLabelTimestamps: this.showLabelTimestamps };
  }

  private settle(): void {
    const view = this.view(); const selected = view.entries[view.index];
    if (selected) this.selectedId = selected.id;
  }

  private isFoldable(view: View, id: string): boolean {
    const kids = view.children.get(id);
    if (!kids || kids.length === 0) return false;
    const parent = view.parents.get(id);
    if (parent === null || parent === undefined) return true;
    return (view.children.get(parent)?.length ?? 0) > 1;
  }

  private segmentStart(view: View, direction: 'up' | 'down'): number {
    const selectedId = view.entries[view.index]?.id;
    if (!selectedId) return view.index;
    const indexById = new Map(view.entries.map((entry, index) => [entry.id, index]));
    let current = selectedId;
    if (direction === 'down') {
      for (;;) {
        const kids = view.children.get(current) ?? [];
        if (kids.length === 0) return indexById.get(current)!;
        if (kids.length > 1) return indexById.get(kids[0]!)!;
        current = kids[0]!;
      }
    }
    for (;;) {
      const parent = view.parents.get(current) ?? null;
      if (parent === null) return indexById.get(current)!;
      if ((view.children.get(parent)?.length ?? 0) > 1) {
        const start = indexById.get(current)!;
        if (start < view.index) return start;
      }
      current = parent;
    }
  }

  private statusLabels(): string {
    const labels = { noTools: ' [no-tools]', userOnly: ' [user]', labeledOnly: ' [labeled]', all: ' [all]' } as Partial<Record<Filter, string>>;
    return `${labels[this.filter] ?? ''}${this.showLabelTimestamps ? ' [+label time]' : ''}`;
  }

  render(width: number): string[] {
    const theme = this.theme(); const view = this.view();
    const lines = ['', theme.fg('border', '─'.repeat(Math.max(1, width))), ...new Text(theme.bold('  Session Tree'), 1, 0).render(width), ...this.helpLines(width, theme),
      truncateToWidth(`  ${theme.fg('muted', 'Type to search:')}${this.query ? ` ${theme.fg('accent', this.query)}` : ''}`, width),
      theme.fg('border', '─'.repeat(Math.max(1, width))), ''];
    if (this.editing) lines.push(...this.labelLines(width, theme));
    else lines.push(...this.listLines(view, width, theme));
    if (this.status) lines.push(truncateToWidth(uiText(this.status), width));
    lines.push('', theme.fg('border', '─'.repeat(Math.max(1, width))));
    return lines.map(line => truncateToWidth(line, width));
  }

  private helpLines(width: number, theme: Theme): string[] {
    const keys = getKeybindings();
    const items = helpItems.map(({ keys: actions, label, labelFirst }) => {
      const text = helpKeys(actions.flatMap(action => keys.getKeys(action).slice(0, 1)));
      if (!text) return label;
      return labelFirst ? `${label} ${text}` : `${text} ${label}`;
    });
    const available = Math.max(1, width); const indent = '  '; const lines: string[] = []; let current = '';
    for (const item of items) {
      const candidate = current ? `${current} · ${item}` : visibleWidth(`${indent}${item}`) <= available ? `${indent}${item}` : item;
      if (!current || visibleWidth(candidate) <= available) { current = candidate; continue; }
      lines.push(...wrapTextWithAnsi(current.trimEnd(), available));
      current = visibleWidth(`${indent}${item}`) <= available ? `${indent}${item}` : item;
    }
    if (current) lines.push(...wrapTextWithAnsi(current.trimEnd(), available));
    return lines.map(line => theme.fg('muted', line));
  }

  private listLines(view: View, width: number, theme: Theme): string[] {
    if (!view.entries.length) {
      return [truncateToWidth(theme.fg('muted', '  No entries found'), width), truncateToWidth(theme.fg('muted', `  (0/0)${this.statusLabels()}`), width)];
    }
    const maxVisible = this.maxVisible();
    const start = Math.max(0, Math.min(view.index - Math.floor(maxVisible / 2), view.entries.length - maxVisible));
    const end = Math.min(start + maxVisible, view.entries.length);
    const rows: RenderedRow[] = [];
    for (let index = start; index < end; index++) {
      const entry = view.entries[index]!; const selected = index === view.index; const layout = view.layout.get(entry.id)!;
      const displayIndent = view.multipleRoots ? Math.max(0, layout.indent - 1) : layout.indent;
      const connector = layout.showConnector && !layout.isVirtualRootChild ? (layout.isLast ? '└─ ' : '├─ ') : '';
      const connectorPosition = connector ? displayIndent - 1 : -1;
      const folded = this.folded.has(entry.id);
      const prefix = Array.from({ length: displayIndent * 3 }, (_, char) => {
        const level = Math.floor(char / 3); const position = char % 3;
        const gutter = layout.gutters.find(item => item.position === level);
        if (gutter) return position === 0 ? (gutter.show ? '│' : ' ') : ' ';
        if (connector && level === connectorPosition) {
          if (position === 0) return layout.isLast ? '└' : '├';
          if (position === 1) return folded ? '⊞' : this.isFoldable(view, entry.id) ? '⊟' : '─';
        }
        return ' ';
      }).join('');
      const foldMarker = folded && !(layout.showConnector && !layout.isVirtualRootChild) ? theme.fg('accent', '⊞ ') : '';
      const pathMarker = this.active.has(entry.id) ? theme.fg('accent', '• ') : '';
      const label = entry.label ? theme.fg('warning', `[${normalize(entry.label)}] `) : '';
      const labelTime = this.showLabelTimestamps && entry.label && entry.labelTimestamp !== undefined
        ? theme.fg('muted', `${formatLabelTimestamp(entry.labelTimestamp)} `) : '';
      const prefixPart = theme.fg('dim', prefix) + foldMarker + pathMarker;
      let gutter = selected ? theme.fg('accent', '› ') : '  ';
      let body = prefixPart + label + labelTime + this.displayText(entry, selected, theme);
      if (selected) { gutter = theme.bg('selectedBg', gutter); body = theme.bg('selectedBg', body); }
      rows.push({ gutter, body, anchorCol: visibleWidth(prefixPart), bodyWidth: visibleWidth(body), selected });
    }
    return [...horizontalViewport(rows, width), truncateToWidth(theme.fg('muted', `  (${view.index + 1}/${view.entries.length})${this.statusLabels()}`), width)];
  }

  private labelLines(width: number, theme: Theme): string[] {
    const hint = (action: Keybinding, description: string) => `${theme.fg('dim', keyText(action))}${theme.fg('muted', ` ${description}`)}`;
    return [
      truncateToWidth(`  ${theme.fg('muted', 'Label (empty to remove):')}`, width),
      ...this.editing!.input.render(Math.max(1, width - 2)).map(line => truncateToWidth(`  ${line}`, width)),
      truncateToWidth(`  ${hint('tui.select.confirm', 'save')}  ${hint('tui.select.cancel', 'cancel')}`, width),
    ];
  }

  private displayText(entry: Entry, selected: boolean, theme: Theme): string {
    let result: string;
    switch (entry.kind) {
      case 'message':
        if (entry.role === 'user') result = theme.fg('accent', 'user: ') + normalize(entry.summary);
        else if (entry.role === 'assistant') {
          const content = normalize(entry.summary);
          if (content) result = theme.fg('success', 'assistant: ') + content;
          else if (entry.stopReason === 'aborted') result = theme.fg('success', 'assistant: ') + theme.fg('muted', '(aborted)');
          else if (entry.errorMessage) result = theme.fg('success', 'assistant: ') + theme.fg('error', normalize(entry.errorMessage).slice(0, 80));
          else result = theme.fg('success', 'assistant: ') + theme.fg('muted', '(no content)');
        } else if (entry.role === 'toolResult') result = theme.fg('muted', `[${entry.title ?? 'tool'}]`);
        else if (entry.role === 'bashExecution') result = theme.fg('dim', `[bash]: ${normalize(entry.summary)}`);
        else result = theme.fg('dim', `[${entry.role ?? 'message'}]`);
        break;
      case 'custom_message': result = theme.fg('customMessageLabel', `[${entry.title ?? ''}]: `) + normalize(entry.summary); break;
      case 'compaction': result = theme.fg('borderAccent', `[${entry.title ?? 'compaction'}]`); break;
      case 'branch_summary': result = theme.fg('warning', '[branch summary]: ') + normalize(entry.summary); break;
      case 'usage': result = ''; break;
      default: result = theme.fg('dim', `[${entry.title ?? entry.kind}]`);
    }
    return selected ? theme.bold(result) : result;
  }

  private copyText(entry: Entry): string | undefined {
    const text = copyKinds.has(entry.kind) ? (entry.summary.trim() || (entry.role === 'assistant' ? entry.errorMessage : undefined)) : undefined;
    return text?.trim() ? text : undefined;
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    if (this.editing) {
      if (keys.matches(data, 'tui.select.cancel')) this.editing = undefined;
      else if (keys.matches(data, 'tui.select.confirm')) this.done({ action: 'label', entryId: this.editing.entryId, label: this.editing.input.getValue().trim(), view: this.viewState() });
      else this.editing.input.handleInput(data);
      return;
    }
    const view = this.view(); const count = view.entries.length; const selected = view.entries[view.index];
    const select = (index: number) => { const entry = view.entries[index]; if (entry) this.selectedId = entry.id; };
    if (keys.matches(data, 'tui.select.cancel')) {
      if (this.query) { this.query = ''; this.folded.clear(); this.settle(); } else this.done(undefined);
      return;
    }
    if (keys.matches(data, 'tui.select.confirm')) { if (selected) this.done({ action: 'select', entryId: selected.id }); return; }
    if (keys.matches(data, 'app.tree.editLabel')) {
      if (selected) { const input = new Input(); input.setValue(selected.label ?? ''); input.focused = true; this.editing = { entryId: selected.id, input }; }
      return;
    }
    if (keys.matches(data, 'app.message.copy') && selected) {
      const text = this.copyText(selected);
      if (!text) { this.status = 'Selected entry has no text to copy.'; this.requestRender(); return; }
      this.status = 'Copying text preview…';
      void this.copy(text).then(() => { this.status = 'Text preview copied.'; }, () => { this.status = 'Clipboard unavailable.'; })
        .finally(() => this.requestRender());
      return;
    }
    if (keys.matches(data, 'app.tree.toggleLabelTimestamp')) { this.showLabelTimestamps = !this.showLabelTimestamps; return; }
    const filter = filters.find(value => keys.matches(data, `app.tree.filter.${value}`));
    if (filter) {
      this.filter = filter === 'default' || this.filter !== filter ? filter : 'default';
      this.folded.clear(); this.settle(); return;
    }
    const cycleForward = keys.matches(data, 'app.tree.filter.cycleForward');
    if (cycleForward || keys.matches(data, 'app.tree.filter.cycleBackward')) {
      this.filter = filters[(filters.indexOf(this.filter) + (cycleForward ? 1 : filters.length - 1)) % filters.length]!;
      this.folded.clear(); this.settle(); return;
    }
    if (keys.matches(data, 'app.tree.foldOrUp') && selected) {
      if (this.isFoldable(view, selected.id) && !this.folded.has(selected.id)) { this.folded.add(selected.id); this.settle(); }
      else select(this.segmentStart(view, 'up'));
      return;
    }
    if (keys.matches(data, 'app.tree.unfoldOrDown') && selected) {
      if (this.folded.has(selected.id)) { this.folded.delete(selected.id); this.settle(); }
      else select(this.segmentStart(view, 'down'));
      return;
    }
    if (!count) return;
    const page = this.maxVisible();
    if (keys.matches(data, 'tui.select.up')) select(view.index === 0 ? count - 1 : view.index - 1);
    else if (keys.matches(data, 'tui.select.down')) select(view.index === count - 1 ? 0 : view.index + 1);
    else if (keys.matches(data, 'tui.editor.cursorLeft') || keys.matches(data, 'tui.select.pageUp')) select(Math.max(0, view.index - page));
    else if (keys.matches(data, 'tui.editor.cursorRight') || keys.matches(data, 'tui.select.pageDown')) select(Math.min(count - 1, view.index + page));
    else if (keys.matches(data, 'tui.editor.deleteCharBackward')) {
      if (this.query) { this.query = this.query.slice(0, -1); this.folded.clear(); this.settle(); }
    } else if (isTextInput(data)) { this.query += data; this.folded.clear(); this.settle(); }
  }
}

export function pickTreeEntry(dialogs: NavigationDialogs, tree: Tree, options: { theme?: (() => Theme) | undefined; selected?: string | undefined; requestRender?: (() => void) | undefined; view?: TreeViewState | undefined } = {}): Promise<TreeSelection | undefined> {
  if (!dialogs.custom) throw new Error('Tree navigation is unavailable in this client.');
  const height = dialogs.viewportHeight ? () => dialogs.viewportHeight!() : undefined;
  return dialogs.custom<TreeSelection | undefined>(done => new TreeNavigator(tree, done, options.theme, options.selected, undefined, options.requestRender, height, options.view));
}

type RenderedRow = { gutter: string; body: string; anchorCol: number; bodyWidth: number; selected: boolean };

const minVisibleAnchorContentWidth = 4;
const maxVisibleAnchorContentWidth = 20;
const minAnchorContextWidth = 2;
const maxAnchorContextWidth = 12;

/** Shifts row bodies left only when the selected row's text would otherwise be off screen. */
function horizontalViewport(rows: RenderedRow[], width: number): string[] {
  const viewportWidth = Math.max(0, width - gutterWidth);
  const maxBodyWidth = rows.reduce((max, row) => Math.max(max, row.bodyWidth), 0);
  const maxScroll = Math.max(0, maxBodyWidth - viewportWidth);
  const selected = rows.find(row => row.selected);
  let scroll = 0;
  if (selected && maxScroll > 0) {
    const minContent = Math.min(maxVisibleAnchorContentWidth, Math.max(minVisibleAnchorContentWidth, Math.floor(viewportWidth / 3)));
    if (selected.anchorCol > viewportWidth - minContent) {
      const context = Math.min(maxAnchorContextWidth, Math.max(minAnchorContextWidth, Math.floor(viewportWidth / 4)));
      scroll = Math.min(maxScroll, selected.anchorCol - context);
    }
  }
  return rows.map(row => {
    const line = scroll > 0 ? `${row.gutter}${sliceByColumn(row.body, scroll, viewportWidth, true)}\x1b[0m` : row.gutter + row.body;
    return truncateToWidth(line, width, '');
  });
}

function helpKeys(keys: string[]): string {
  if (!keys.length) return '';
  return formatKeyText(compactRawKeys(keys))
    .replace(/\bpageUp\b/gu, 'pgup').replace(/\bpageDown\b/gu, 'pgdn')
    .replace(/\bup\b/gu, '↑').replace(/\bdown\b/gu, '↓').replace(/\bleft\b/gu, '←').replace(/\bright\b/gu, '→');
}

function formatKeyText(key: string): string {
  return key.split('/').map(part => part.split('+').map(item => process.platform === 'darwin' && item.toLowerCase() === 'alt' ? 'option' : item).join('+')).join('/');
}

function compactRawKeys(keys: string[]): string {
  if (keys.length === 1) return keys[0]!;
  const parts = keys.map(key => {
    const separator = key.lastIndexOf('+');
    return separator === -1 ? { prefix: '', suffix: key } : { prefix: key.slice(0, separator + 1), suffix: key.slice(separator + 1) };
  });
  const prefix = parts[0]!.prefix;
  return prefix && parts.every(part => part.prefix === prefix) ? `${prefix}${parts.map(part => part.suffix).join('/')}` : keys.join('/');
}

function formatLabelTimestamp(timestamp: number): string {
  const date = new Date(timestamp); const now = new Date();
  const time = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
  if (date.toDateString() === now.toDateString()) return time;
  const month = date.getMonth() + 1; const day = date.getDate();
  if (date.getFullYear() === now.getFullYear()) return `${month}/${day} ${time}`;
  return `${date.getFullYear().toString().slice(-2)}/${month}/${day} ${time}`;
}

function normalize(value: string): string {
  return uiText(value).replace(/[\n\t]/gu, ' ').trim();
}

function isTextInput(data: string): boolean {
  return data.length > 0 && ![...data].some(ch => { const code = ch.charCodeAt(0); return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f); });
}
