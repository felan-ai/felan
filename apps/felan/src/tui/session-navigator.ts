import { homedir } from 'node:os';
import { Input, Key, fuzzyMatch, getKeybindings, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type Keybinding } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { OperationResult } from '@felan-ai/session-protocol';
import type { TuiDialogHost, TuiDialogs } from './dialogs.js';
import { defaultClientTheme } from './theme.js';
import { uiText } from '../client/ui.js';

export type SessionRow = OperationResult<'sessions.list'>['entries'][number];
export type NavigationDialogs = TuiDialogHost & Partial<Pick<TuiDialogs, 'custom' | 'viewportHeight' | 'requestRender'>>;
/** The first page is shown at once; `more` yields the remaining pages while the picker is open. */
export interface SessionListing { readonly first: readonly SessionRow[]; readonly more: AsyncIterable<readonly SessionRow[]> }
export type SessionSelection = { session: string; action: 'resume' | 'rename' | 'delete' };

const maxVisible = 10;
// Every rendered line except session rows: spacer, border, spacer, three header lines, spacer, search, spacer, counter, spacer, border.
const chromeLines = 12;
const activeStates: Partial<Record<SessionRow['run']['state'], string>> = { running: 'running', waiting: 'waiting for input', cancelling: 'cancelling' };

export class SessionNavigator implements Component, Focusable {
  private readonly sessions: SessionRow[] = [];
  private readonly known = new Set<string>();
  private loaded = true;
  private closed = false;
  private readonly search = new Input();
  private scope: 'current' | 'all' = 'current';
  private recent = true;
  private namedOnly = false;
  private showPath = false;
  private selected: string | undefined;
  private offset = 0;
  private status = '';
  private deleting: string | undefined;
  private readonly theme: () => Theme;

  constructor(initial: readonly SessionRow[], private readonly cwd: string,
    private readonly current: string | undefined, private readonly done: (selection: SessionSelection | undefined) => void,
    theme?: () => Theme, private readonly manage = true, private readonly viewportHeight: () => number = () => chromeLines + maxVisible) {
    const fallback = theme ? undefined : defaultClientTheme(); this.theme = theme ?? (() => fallback!);
    this.add(initial);
    this.selected = current; this.focused = true;
  }

  /** Adds rows from later pages while the picker is open. A session that appears on several pages is listed once. */
  follow(pages: AsyncIterable<readonly SessionRow[]>, render: () => void): void {
    this.loaded = false;
    void (async () => {
      try {
        for await (const page of pages) {
          if (this.closed) break;
          this.add(page); render();
        }
      } catch {
        if (!this.closed) this.status = 'Some sessions could not be loaded.';
      } finally { this.loaded = true; render(); }
    })();
  }

  dispose(): void { this.closed = true; }

  private add(page: readonly SessionRow[]): void {
    for (const row of page) if (!this.known.has(row.session)) { this.known.add(row.session); this.sessions.push(row); }
  }

  get focused(): boolean { return this.search.focused; }
  set focused(value: boolean) { this.search.focused = value; }
  invalidate(): void { this.search.invalidate(); }

  private rows(): SessionRow[] {
    const query = this.search.getValue().trim().toLowerCase();
    return this.sessions.filter(row => (this.scope === 'all' || row.cwd === this.cwd) && (!this.namedOnly || row.title.trim())
      && sessionMatches(`${row.title} ${row.preview ?? ''} ${row.session} ${row.cwd} ${activeStates[row.run.state] ?? ''}`, query))
      .sort((a, b) => this.recent ? b.lastActivity - a.lastActivity || a.session.localeCompare(b.session)
        : label(a).localeCompare(label(b)));
  }

  private visible(): number { return Math.max(1, Math.min(maxVisible, this.viewportHeight() - chromeLines)); }

  render(width: number): string[] {
    const rows = this.rows(); const index = Math.max(0, rows.findIndex(row => row.session === this.selected));
    this.selected = rows[index]?.session;
    const theme = this.theme(); const border = theme.fg('accent', '─'.repeat(Math.max(1, width)));
    const lines = ['', border, '', ...this.header(width), '', ...this.search.render(width), ''];
    if (!rows.length) lines.push(theme.fg('muted', truncateToWidth(this.loaded ? this.empty() : 'Loading sessions…', width, '…')));
    const count = this.visible();
    // Scroll only when the selection leaves the viewport, and never leave rows empty below the last session.
    if (index < this.offset) this.offset = index;
    else if (index >= this.offset + count) this.offset = index - count + 1;
    this.offset = Math.max(0, Math.min(this.offset, rows.length - count));
    for (let at = this.offset; at < Math.min(rows.length, this.offset + count); at++) lines.push(this.line(rows[at]!, at === index, width));
    if (rows.length) lines.push(theme.fg('muted', truncateToWidth(`  (${index + 1}/${rows.length}${this.loaded ? '' : ', loading'})`, width, '')));
    lines.push('', border);
    return lines.map(line => truncateToWidth(line, width));
  }

  private header(width: number): string[] {
    const theme = this.theme(); const keys = getKeybindings();
    const left = theme.bold(`Resume Session (${this.scope === 'current' ? 'Current Folder' : 'All'})`);
    const scope = this.scope === 'current' ? `${theme.fg('accent', '◉ Current Folder')}${theme.fg('muted', ' | ○ All')}`
      : `${theme.fg('muted', '○ Current Folder | ')}${theme.fg('accent', '◉ All')}`;
    const right = truncateToWidth(`${scope}  ${theme.fg('muted', 'Name: ')}${theme.fg('accent', this.namedOnly ? 'Named' : 'All')}  ${theme.fg('muted', 'Sort: ')}${theme.fg('accent', this.recent ? 'Recent' : 'Name')}`, width, '');
    const title = truncateToWidth(left, Math.max(0, width - visibleWidth(right) - 1), '');
    const first = `${title}${' '.repeat(Math.max(0, width - visibleWidth(title) - visibleWidth(right)))}${right}`;
    if (this.status) return [first, theme.fg('error', truncateToWidth(this.status, width, '…')), ''];
    const hint = (action: Keybinding, text: string) => `${theme.fg('dim', keys.getKeys(action).join('/') || 'unbound')}${theme.fg('muted', ` ${text}`)}`;
    if (this.deleting) {
      const key = (action: Keybinding, text: string) => `${keys.getKeys(action).join('/') || 'unbound'} ${text}`;
      return [first, theme.fg('error', truncateToWidth(`Delete session? ${key('tui.select.confirm', 'confirm')} · ${key('tui.select.cancel', 'cancel')}`, width, '…')), ''];
    }
    const separator = theme.fg('muted', ' · ');
    return [first, truncateToWidth(`${theme.fg('dim', 'tab')}${theme.fg('muted', ' scope')}${separator}${theme.fg('muted', '"phrase" exact')}`, width, '…'),
      truncateToWidth([hint('app.session.toggleSort', 'sort'), hint('app.session.toggleNamedFilter', 'named'),
        ...(this.manage ? [hint('app.session.delete', 'delete')] : []), hint('app.session.togglePath', `path (${this.showPath ? 'on' : 'off'})`),
        ...(this.manage ? [hint('app.session.rename', 'rename')] : [])].join(separator), width, '…')];
  }

  private empty(): string {
    if (this.search.getValue().trim()) return '  No matching sessions.';
    const named = getKeybindings().getKeys('app.session.toggleNamedFilter').join('/');
    if (this.namedOnly) return this.scope === 'all' ? `  No named sessions found. Press ${named} to show all.`
      : `  No named sessions in current folder. Press ${named} to show all, or Tab to view all.`;
    return this.scope === 'all' ? '  No sessions found' : '  No sessions in current folder. Press Tab to view all.';
  }

  private line(row: SessionRow, selected: boolean, width: number): string {
    const theme = this.theme(); const named = !!row.title.trim();
    const state = activeStates[row.run.state];
    const right = [this.showPath ? row.session : '', this.scope === 'all' ? shortenPath(uiText(row.cwd).replace(/\s+/gu, ' ')) : '',
      age(row.lastActivity)].filter(Boolean).join(' ');
    const rightWidth = visibleWidth(right) + (state ? visibleWidth(state) + 1 : 0);
    const text = truncateToWidth(label(row), Math.max(10, width - 2 - rightWidth - 2), '…');
    const color = row.session === this.current ? 'accent' : named ? 'warning' : undefined;
    let message = color ? theme.fg(color, text) : text;
    if (selected) message = theme.bold(message);
    const leftPart = `${selected ? theme.fg('accent', '› ') : '  '}${message}`;
    const styledRight = `${state ? `${theme.fg('warning', state)} ` : ''}${theme.fg('dim', right)}`;
    const line = `${leftPart}${' '.repeat(Math.max(1, width - visibleWidth(leftPart) - rightWidth))}${styledRight}`;
    return truncateToWidth(selected ? theme.bg('selectedBg', line) : line, width);
  }

  handleInput(data: string): void {
    const keys = getKeybindings(); const rows = this.rows(); let index = Math.max(0, rows.findIndex(row => row.session === this.selected));
    this.status = '';
    if (this.deleting) {
      const session = this.deleting;
      if (keys.matches(data, 'tui.select.confirm')) { this.deleting = undefined; this.done({ session, action: 'delete' }); }
      else if (keys.matches(data, 'tui.select.cancel')) this.deleting = undefined;
      return;
    }
    if (keys.matches(data, 'tui.select.cancel')) { this.done(undefined); return; }
    const selected = rows[index];
    if (keys.matches(data, 'tui.select.confirm')) { if (selected) this.done({ session: selected.session, action: 'resume' }); return; }
    if (this.manage && keys.matches(data, 'app.session.rename')) {
      if (selected && selected.session === this.current) this.done({ session: selected.session, action: 'rename' });
      else this.status = 'Resume this session before renaming it.';
      return;
    }
    if (this.manage && (keys.matches(data, 'app.session.delete') || keys.matches(data, 'app.session.deleteNoninvasive') && !this.search.getValue())) {
      if (selected?.session === this.current) this.status = 'Cannot delete the currently active session.';
      else if (selected) this.deleting = selected.session;
      return;
    }
    if (matchesKey(data, Key.tab)) this.scope = this.scope === 'current' ? 'all' : 'current';
    else if (keys.matches(data, 'app.session.toggleSort')) this.recent = !this.recent;
    else if (keys.matches(data, 'app.session.toggleNamedFilter')) this.namedOnly = !this.namedOnly;
    else if (keys.matches(data, 'app.session.togglePath')) this.showPath = !this.showPath;
    else if (keys.matches(data, 'tui.select.up')) index--;
    else if (keys.matches(data, 'tui.select.down')) index++;
    else if (keys.matches(data, 'tui.select.pageUp')) index -= this.visible();
    else if (keys.matches(data, 'tui.select.pageDown')) index += this.visible();
    else { this.search.handleInput(data); this.selected = undefined; return; }
    this.selected = rows[Math.max(0, Math.min(rows.length - 1, index))]?.session;
  }
}

function label(row: SessionRow): string {
  return uiText(row.title.trim() || row.preview?.trim() || row.session).replace(/\s+/gu, ' ').trim();
}

function shortenPath(path: string): string {
  const home = homedir();
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

function age(timestamp: number, now = Date.now()): string {
  const minutes = Math.floor((now - timestamp) / 60_000); const hours = Math.floor(minutes / 60); const days = Math.floor(hours / 24);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

function sessionMatches(text: string, query: string): boolean {
  const clean = uiText(text).toLowerCase();
  const phrases = [...query.matchAll(/"([^"]*)"|(\S+)/gu)];
  return phrases.every(match => match[1] !== undefined ? clean.includes(match[1]) : fuzzyMatch(match[2]!, clean).matches);
}

export function pickSession(dialogs: NavigationDialogs, listing: SessionListing, cwd: string, current?: string,
  theme?: () => Theme, manage = true): Promise<SessionSelection | undefined> {
  if (!dialogs.custom) throw new Error('Session navigation is unavailable in this client.');
  const height = dialogs.viewportHeight ? () => dialogs.viewportHeight!() : undefined;
  return dialogs.custom<SessionSelection | undefined>(done => {
    const picker = new SessionNavigator(listing.first, cwd, current, done, theme, manage, height);
    picker.follow(listing.more, () => dialogs.requestRender?.());
    return picker;
  });
}
