import { homedir } from 'node:os';
import {
  Input,
  fuzzyMatch,
  Key,
  matchesKey,
  ProcessTerminal,
  truncateToWidth,
  TuiMainScreen,
  type Component,
  type Focusable,
  type TUI,
} from '@earendil-works/pi-tui';
import type { SessionInfo } from '@earendil-works/pi-coding-agent';

type PickerScope = 'current' | 'all';
type PickerSort = 'threaded' | 'recent' | 'fuzzy';

export interface SelectLocalSessionOptions {
  readonly currentSessions: readonly SessionInfo[];
  readonly allSessions: readonly SessionInfo[];
  readonly agentDir: string;
  readonly showHardwareCursor?: boolean;
  readonly clearOnShrink?: boolean;
  readonly createTui?: () => TUI;
}

interface PickerSession {
  readonly session: SessionInfo;
  readonly depth: number;
}

export async function selectLocalSession(
  options: SelectLocalSessionOptions,
): Promise<string | undefined> {
  if (options.allSessions.length === 0) return undefined;

  const ui = options.createTui?.() ?? new TuiMainScreen(
    new ProcessTerminal(),
    options.showHardwareCursor,
    options.agentDir,
  );
  if (options.clearOnShrink !== undefined) ui.setClearOnShrink(options.clearOnShrink);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (path: string | undefined) => {
      if (settled) return;
      settled = true;
      ui.stop();
      resolve(path);
    };
    const picker = new LocalSessionPicker(
      options.currentSessions,
      options.allSessions,
      (path) => finish(path),
      () => finish(undefined),
      () => ui.requestRender(),
    );
    ui.addChild(picker);
    ui.setFocus(picker);
    ui.start();
  });
}

export class LocalSessionPicker implements Component, Focusable {
  readonly #currentSessions: readonly SessionInfo[];
  readonly #allSessions: readonly SessionInfo[];
  readonly #onSelect: (path: string) => void;
  readonly #onCancel: () => void;
  readonly #requestRender: () => void;
  readonly #searchInput = new Input();
  #scope: PickerScope = 'current';
  #sort: PickerSort = 'threaded';
  #namedOnly = false;
  #showPath = false;
  #selectedIndex = 0;
  #focused = false;

  constructor(
    currentSessions: readonly SessionInfo[],
    allSessions: readonly SessionInfo[],
    onSelect: (path: string) => void,
    onCancel: () => void,
    requestRender: () => void = () => {},
  ) {
    this.#currentSessions = currentSessions;
    this.#allSessions = allSessions;
    this.#onSelect = onSelect;
    this.#onCancel = onCancel;
    this.#requestRender = requestRender;
  }

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
    this.#searchInput.focused = value;
  }

  invalidate(): void {
    this.#searchInput.invalidate();
  }

  render(width: number): string[] {
    const sessions = this.#visibleSessions();
    const scope = this.#scope === 'current' ? 'Current Folder' : 'All';
    const nameFilter = this.#namedOnly ? 'Named' : 'All';
    const lines = [
      truncateToWidth(`Resume Session (${scope})  Sort: ${capitalize(this.#sort)}  Name: ${nameFilter}`, width),
      truncateToWidth('Tab scope  Ctrl+S sort  Ctrl+N named  Ctrl+P path  Enter resume  Esc cancel', width),
      `Search: ${this.#searchInput.render(Math.max(1, width - 8))[0] ?? ''}`,
      '',
    ];

    if (sessions.length === 0) {
      const message = this.#scope === 'current'
        ? 'No sessions in current folder. Press Tab to view all.'
        : 'No sessions found.';
      lines.push(truncateToWidth(message, width));
      return lines;
    }

    this.#selectedIndex = Math.max(0, Math.min(this.#selectedIndex, sessions.length - 1));
    const first = Math.max(0, Math.min(this.#selectedIndex - 4, sessions.length - 10));
    for (const [index, item] of sessions.slice(first, first + 10).entries()) {
      const absoluteIndex = first + index;
      const session = item.session;
      const label = cleanText(session.name ?? session.firstMessage) || session.id;
      const treePrefix = item.depth === 0 ? '' : `${'  '.repeat(item.depth - 1)}└─ `;
      const metadata = [
        this.#showPath ? shortenPath(session.path) : undefined,
        this.#scope === 'all' ? shortenPath(session.cwd) : undefined,
        `${session.messageCount} messages`,
        formatAge(session.modified),
      ].filter((value): value is string => Boolean(value)).join(' · ');
      const marker = absoluteIndex === this.#selectedIndex ? '> ' : '  ';
      lines.push(truncateToWidth(`${marker}${treePrefix}${label}  ${metadata}`, width));
    }

    if (sessions.length > 10) {
      lines.push(`(${this.#selectedIndex + 1}/${sessions.length})`);
    }
    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.tab)) {
      this.#scope = this.#scope === 'current' ? 'all' : 'current';
      this.#selectedIndex = 0;
    } else if (matchesKey(data, Key.ctrl('s'))) {
      this.#sort = this.#sort === 'threaded' ? 'recent' : this.#sort === 'recent' ? 'fuzzy' : 'threaded';
      this.#selectedIndex = 0;
    } else if (matchesKey(data, Key.ctrl('n'))) {
      this.#namedOnly = !this.#namedOnly;
      this.#selectedIndex = 0;
    } else if (matchesKey(data, Key.ctrl('p'))) {
      this.#showPath = !this.#showPath;
    } else if (matchesKey(data, Key.up)) {
      this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
    } else if (matchesKey(data, Key.down)) {
      this.#selectedIndex = Math.max(
        0,
        Math.min(this.#visibleSessions().length - 1, this.#selectedIndex + 1),
      );
    } else if (matchesKey(data, Key.pageUp)) {
      this.#selectedIndex = Math.max(0, this.#selectedIndex - 10);
    } else if (matchesKey(data, Key.pageDown)) {
      this.#selectedIndex = Math.max(
        0,
        Math.min(this.#visibleSessions().length - 1, this.#selectedIndex + 10),
      );
    } else if (matchesKey(data, Key.enter)) {
      const selected = this.#visibleSessions()[this.#selectedIndex];
      if (selected) this.#onSelect(selected.session.path);
    } else if (matchesKey(data, Key.escape)) {
      this.#onCancel();
    } else {
      this.#searchInput.handleInput(data);
      this.#selectedIndex = 0;
    }
    this.#requestRender();
  }

  #visibleSessions(): PickerSession[] {
    const sessions = this.#scope === 'current' ? this.#currentSessions : this.#allSessions;
    const named = this.#namedOnly ? sessions.filter((session) => Boolean(session.name?.trim())) : sessions;
    const query = this.#searchInput.getValue().trim();
    const matched = query.length === 0
      ? [...named]
      : named.filter((session) => fuzzyMatch(query.toLowerCase(), sessionSearchText(session)).matches);

    if (this.#sort === 'threaded' && query.length === 0) return threadSessions(matched);
    if (this.#sort === 'recent') {
      return matched
        .sort((left, right) => right.modified.getTime() - left.modified.getTime())
        .map((session) => ({ session, depth: 0 }));
    }
    return matched
      .map((session) => ({ session, score: fuzzyScore(sessionSearchText(session), query.toLowerCase()) }))
      .sort((left, right) => left.score - right.score || right.session.modified.getTime() - left.session.modified.getTime())
      .map(({ session }) => ({ session, depth: 0 }));
  }
}

function sessionSearchText(session: SessionInfo): string {
  return `${session.id} ${session.name ?? ''} ${session.allMessagesText} ${session.cwd}`.toLowerCase();
}

function fuzzyScore(text: string, query: string): number {
  if (query.length === 0) return 0;
  let score = 0;
  let cursor = 0;
  for (const character of query) {
    const match = text.indexOf(character, cursor);
    if (match === -1) return Number.POSITIVE_INFINITY;
    score += match - cursor;
    cursor = match + 1;
  }
  return score;
}

function threadSessions(sessions: readonly SessionInfo[]): PickerSession[] {
  const children = new Map<string, SessionInfo[]>();
  const paths = new Set(sessions.map((session) => session.path));
  const roots: SessionInfo[] = [];
  for (const session of sessions) {
    const parent = session.parentSessionPath;
    if (!parent || !paths.has(parent)) {
      roots.push(session);
      continue;
    }
    children.set(parent, [...(children.get(parent) ?? []), session]);
  }
  const byRecent = (left: SessionInfo, right: SessionInfo) => right.modified.getTime() - left.modified.getTime();
  const result: PickerSession[] = [];
  const visit = (session: SessionInfo, depth: number) => {
    result.push({ session, depth });
    for (const child of (children.get(session.path) ?? []).sort(byRecent)) visit(child, depth + 1);
  };
  for (const root of roots.sort(byRecent)) visit(root, 0);
  return result;
}

function cleanText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function shortenPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function formatAge(modified: Date): string {
  const minutes = Math.max(0, Math.floor((Date.now() - modified.getTime()) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
}
