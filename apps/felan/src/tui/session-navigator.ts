import { Input, Key, fuzzyMatch, getKeybindings, matchesKey, truncateToWidth, type Component, type Focusable } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { OperationResult } from '@felan-ai/session-protocol';
import type { TuiDialogHost, TuiDialogs } from './dialogs.js';
import { defaultClientTheme } from './theme.js';
import { uiText } from '../client/ui.js';

export type SessionRow = OperationResult<'sessions.list'>['entries'][number];
export type NavigationDialogs = TuiDialogHost & Partial<Pick<TuiDialogs, 'custom'>>;
export type SessionSelection = { session: string; action: 'resume' | 'rename' | 'delete' };

export class SessionNavigator implements Component, Focusable {
  private readonly search = new Input();
  private scope: 'current' | 'all' = 'current';
  private recent = true;
  private namedOnly = false;
  private showPath = false;
  private selected: string | undefined;
  private status = '';
  private readonly theme: () => Theme;

  constructor(private readonly sessions: readonly SessionRow[], private readonly cwd: string,
    private readonly current: string | undefined, private readonly done: (selection: SessionSelection | undefined) => void,
    theme?: () => Theme, private readonly manage = true) {
    const initial = theme ? undefined : defaultClientTheme(); this.theme = theme ?? (() => initial!);
    this.selected = current; this.focused = true;
  }

  get focused(): boolean { return this.search.focused; }
  set focused(value: boolean) { this.search.focused = value; }
  invalidate(): void { this.search.invalidate(); }

  private rows(): SessionRow[] {
    const query = this.search.getValue().trim().toLowerCase();
    return this.sessions.filter(row => (this.scope === 'all' || row.cwd === this.cwd) && (!this.namedOnly || row.title.trim())
      && sessionMatches(`${row.title} ${row.session} ${row.cwd} ${row.state} ${row.run.state} ${row.residency}`, query))
      .sort((a, b) => this.recent ? b.lastActivity - a.lastActivity || a.session.localeCompare(b.session)
        : (a.title || a.session).localeCompare(b.title || b.session));
  }

  render(width: number): string[] {
    const rows = this.rows(); const index = Math.max(0, rows.findIndex(row => row.session === this.selected));
    this.selected = rows[index]?.session;
    const theme = this.theme(); const keys = getKeybindings();
    const key = (action: Parameters<typeof keys.getKeys>[0]) => keys.getKeys(action).join('/') || 'unbound';
    const lines = [theme.fg('accent', theme.bold(`Resume Session (${this.scope === 'current' ? 'Current Folder' : 'All'})`)),
      theme.fg('dim', `Tab scope · ${key('app.session.toggleSort')} sort (${this.recent ? 'Recent' : 'Name'}) · ${key('app.session.toggleNamedFilter')} named (${this.namedOnly ? 'Named' : 'All'}) · ${key('app.session.togglePath')} path`),
      theme.fg('dim', `${key('tui.select.confirm')} resume${this.manage ? ` · ${key('app.session.rename')} rename current · ${key('app.session.delete')} delete closed` : ''} · ${key('tui.select.cancel')} cancel`),
      `Search names, IDs, folders, status ("phrase" exact): ${this.search.render(Math.max(1, width - 51))[0] ?? ''}`, ''];
    if (!rows.length) lines.push(theme.fg('dim', this.search.getValue() || this.namedOnly ? 'No matching sessions.'
      : this.scope === 'current' ? 'No sessions in current folder. Press Tab to view all.' : 'No sessions found.'));
    const count = this.showPath ? 6 : 10; const start = Math.max(0, index - Math.floor(count / 2));
    for (const row of rows.slice(start, start + count)) {
      const active = row.session === this.current ? '● ' : '';
      const title = uiText(row.title).replace(/\s+/gu, ' ').trim() || row.session;
      const status = row.state === 'closed' ? 'closed' : row.run.state;
      const text = truncateToWidth(`${row.session === this.selected ? '›' : ' '} ${active}${title} · ${status} · ${row.residency} · ${uiText(row.cwd).replace(/\s+/gu, ' ')}`, width);
      lines.push(row.session === this.selected ? theme.fg('accent', theme.bold(text)) : text);
      if (this.showPath) lines.push(theme.fg('dim', truncateToWidth(`    Session: ${row.session} · Folder: ${uiText(row.cwd).replace(/\s+/gu, ' ')}`, width)));
    }
    if (rows.length) lines.push(theme.fg('dim', `(${index + 1}/${rows.length})`));
    if (this.status) lines.push(theme.fg('dim', this.status));
    return lines.flatMap(line => line.split('\n').map(part => truncateToWidth(part, width)));
  }

  handleInput(data: string): void {
    const keys = getKeybindings(); const rows = this.rows(); let index = Math.max(0, rows.findIndex(row => row.session === this.selected));
    if (keys.matches(data, 'tui.select.cancel')) { this.done(undefined); return; }
    const selected = rows[index];
    if (keys.matches(data, 'tui.select.confirm')) { if (selected) this.done({ session: selected.session, action: 'resume' }); return; }
    if (this.manage && keys.matches(data, 'app.session.rename')) {
      if (selected && selected.session === this.current) this.done({ session: selected.session, action: 'rename' });
      else this.status = 'Resume this session before renaming it.';
      return;
    }
    if (this.manage && (keys.matches(data, 'app.session.delete') || keys.matches(data, 'app.session.deleteNoninvasive'))) {
      const row = rows[index];
      if (row?.state === 'closed' && row.residency === 'evicted' && row.run.state === 'idle') this.done({ session: row.session, action: 'delete' });
      else this.status = 'Deletion requires a closed, evicted, idle session. Use /close after attaching.';
      return;
    }
    if (matchesKey(data, Key.tab)) this.scope = this.scope === 'current' ? 'all' : 'current';
    else if (keys.matches(data, 'app.session.toggleSort')) this.recent = !this.recent;
    else if (keys.matches(data, 'app.session.toggleNamedFilter')) this.namedOnly = !this.namedOnly;
    else if (keys.matches(data, 'app.session.togglePath')) this.showPath = !this.showPath;
    else if (keys.matches(data, 'tui.select.up')) index--;
    else if (keys.matches(data, 'tui.select.down')) index++;
    else if (matchesKey(data, Key.pageUp)) index -= 10;
    else if (matchesKey(data, Key.pageDown)) index += 10;
    else { this.search.handleInput(data); this.selected = undefined; return; }
    this.selected = rows[Math.max(0, Math.min(rows.length - 1, index))]?.session;
  }
}

function sessionMatches(text: string, query: string): boolean {
  const clean = uiText(text).toLowerCase();
  const phrases = [...query.matchAll(/"([^"]*)"|(\S+)/gu)];
  return phrases.every(match => match[1] !== undefined ? clean.includes(match[1]) : fuzzyMatch(match[2]!, clean).matches);
}

export function pickSession(dialogs: NavigationDialogs, sessions: readonly SessionRow[], cwd: string, current?: string,
  theme?: () => Theme, manage = true): Promise<SessionSelection | undefined> {
  if (!dialogs.custom) throw new Error('Session navigation is unavailable in this client.');
  return dialogs.custom<SessionSelection | undefined>(done => new SessionNavigator(sessions, cwd, current, done, theme, manage));
}
