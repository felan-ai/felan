import { LIMITS, type Message, type Operation, type OperationParams, type OperationResult, type ResponseFor, type SessionSnapshot } from '@felan-ai/session-protocol';
import type { DaemonIdentity } from '@felan-ai/session-protocol';
import type { SessionClient } from '../client/client.js';
import { describeBlocked } from '../client/diagnostics.js';
import { formatHostBlocked } from '../client/daemon-blocked.js';
import type { SessionListing } from './session-navigator.js';

type Connection = Pick<SessionClient, 'status' | 'reconnection' | 'incompatibleActiveWork' | 'identity' | 'capabilities' | 'connect' | 'request' | 'attach' | 'retryAttach' | 'detach' | 'readAttachment' | 'getInteractions' | 'subscribe' | 'close'>;
type SessionSummary = OperationResult<'sessions.list'>['entries'][number];
const PICKER_FIRST_PAGE = 20;
const RETAINED_PROMPT_ECHOES = 32;
/** A client-only line that scrolls with the transcript after its anchor entry, like Pi's chat status lines; never persisted. */
export interface TranscriptNote { readonly after?: string; readonly text: string; readonly level: 'info' | 'warning' | 'error' }
export interface PromptEcho { readonly text: string; readonly timestamp: number; readonly message?: string }
type SessionPromptEcho = {
  after: string | undefined; previousRun: string | undefined; run: string | undefined; running: boolean; settled: boolean; accepted: boolean;
  echo: { text: string; timestamp: number; message?: string };
};
/** Status notes replace an immediately preceding status note, like Pi's showStatus; other notes always append. */
type SessionNote = TranscriptNote & { readonly session?: string; readonly status: boolean };
export interface TuiSessionOptions {
  cwd: string;
  sessionId?: string;
  sessionDir?: string;
  continueRecent?: boolean;
  resume?: boolean;
  extensions?: string[];
  config?: OperationParams<'sessions.create'>['config'];
}

export type SessionEntry = 'new' | 'resume' | 'fork';

export class TuiSessionController {
  private selected: string | undefined;
  private entered: SessionEntry = 'resume';
  private retained: { session: string; branch: string; entries: Message[] } | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly unsubscribe: () => void;
  private closed = false;
  private submitting = false;
  private startingSession = false;
  private selection: Promise<void> = Promise.resolve();
  private historyLoading: Promise<void> | undefined;
  private disposing: Promise<void> | undefined;
  private sessionNotes: SessionNote[] = [];
  private sessionPromptEchoes: SessionPromptEcho[] = [];
  private notificationSession: string | undefined;
  private readonly seenNotifications = new Map<string, string>();
  private hostBlockedNotice = false;
  notice = '';

  constructor(readonly client: Connection) {
    this.unsubscribe = client.subscribe(() => { this.mergeSnapshot(); this.emit(); });
  }

  get sessionId(): string | undefined { return this.selected; }
  /** How the attached session was entered, in Pi's `session_start` terms. */
  get sessionEntry(): SessionEntry { return this.entered; }
  /**
   * The attached session has no user, assistant or shell message, so there is nothing to resume and the daemon discards
   * it when idle if it is a draft. Without a snapshot, only a newly created session counts.
   */
  get unprompted(): boolean {
    const entries = this.snapshot?.history.entries;
    if (!entries) return this.sessionEntry === 'new';
    return !entries.some(entry => entry.role === 'user' || entry.role === 'assistant' || entry.customType === 'bashExecution');
  }
  get state() { return this.selected ? this.client.readAttachment(this.selected)?.state : undefined; }
  /** Explains a blocked attachment, e.g. `Session recovery did not complete (re-attach got no answer: …).` */
  get blockedText(): string {
    const reason = describeBlocked(this.selected ? this.client.readAttachment(this.selected)?.blocked : undefined);
    return `Session recovery did not complete${reason ? ` (${reason})` : ''}.`;
  }
  get snapshot(): SessionSnapshot | undefined { return this.state?.snapshot; }
  get history(): readonly Message[] { return this.retained?.entries ?? []; }
  get busy(): boolean { return this.submitting; }
  /** Notes for the selected session, or notes awaiting the first attachment when none is selected. */
  get notes(): readonly TranscriptNote[] { return this.sessionNotes.filter(note => note.session === this.selected); }
  get promptEchoes(): readonly PromptEcho[] { return this.sessionPromptEchoes.map(pending => pending.echo); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  setNotice(message: string, hostBlocked = this.hostBlockedNotice && (!message || message === this.notice)): void {
    if (this.closed) return;
    this.hostBlockedNotice = hostBlocked;
    this.notice = message;
    if (message) this.addNote(message, 'info', true);
    this.emit();
  }
  announce(message: string, level: TranscriptNote['level'] = 'info'): void {
    if (this.closed) return;
    this.addNote(message, level, false); this.emit();
  }

  /** True while startup connects, attaches or creates the first session; the screen does not warn about a missing session then. */
  get starting(): boolean { return this.startingSession; }

  async start(options: TuiSessionOptions, pick?: (listing: SessionListing) => Promise<string | undefined>, connected?: () => Promise<void | boolean>): Promise<void> {
    this.startingSession = true;
    try { await this.open(options, pick, connected); }
    finally { this.startingSession = false; this.emit(); }
  }

  private async open(options: TuiSessionOptions, pick?: (listing: SessionListing) => Promise<string | undefined>, connected?: () => Promise<void | boolean>): Promise<void> {
    await this.client.connect();
    if (this.closed) return;
    if (await connected?.() === false) return;
    if (this.closed) return;
    let id: string | undefined;
    if (options.resume) {
      if (!pick) throw new Error('Session selection requires an interactive picker.');
      id = await pick(await this.sessionListing(options.cwd));
      if (!id) return;
    } else if (options.sessionId) {
      id = await this.resolveSession(options.sessionId);
      if (!id) this.setNotice(`Session '${options.sessionId}' was not found. Starting a new session.`);
    } else if (options.continueRecent) {
      id = (await this.sessions(options.cwd)).filter(row => row.state === 'open').sort((a, b) => b.lastActivity - a.lastActivity)[0]?.session;
    }
    if (this.closed) return;
    if (id) {
      await this.attach(id);
      if (options.extensions?.length) this.setNotice('Resumed sessions keep their saved extensions; --extension applies to new sessions.');
      if (options.config && Object.keys(options.config).length) {
        const result = await this.perform('config.set', { scope: 'session', values: options.config }, id);
        if (result.outcome !== 'accepted') throw new Error(this.notice);
        await this.waitUntilLive(id);
      }
    } else await this.create(options);
  }

  private async resolveSession(query: string): Promise<string | undefined> {
    // An exact ID attaches without a listing and also reaches an unlisted draft; the caller's later attach is then a no-op.
    try { await this.attach(query, 'resume', false); return query; }
    catch (error) { if ((error as { code?: unknown }).code !== 'not_found') throw error; }
    for await (const page of this.sessionPages()) {
      const match = page.find(row => row.session.startsWith(query));
      if (match) return match.session;
    }
    return undefined;
  }

  async sessions(cwd?: string): Promise<SessionSummary[]> {
    const entries: SessionSummary[] = [];
    for await (const page of this.sessionPages(cwd)) entries.push(...page);
    return entries;
  }

  /** The resume picker opens on the current folder's newest sessions; sessions from every folder follow as pages load. */
  async sessionListing(cwd: string): Promise<SessionListing> {
    const pages = this.sessionPages(cwd, PICKER_FIRST_PAGE);
    const first = await pages.next();
    await pages.return(undefined);
    return { first: first.done ? [] : first.value, more: this.sessionPages() };
  }

  /** Root sessions, newest first, one page at a time. */
  async *sessionPages(cwd?: string, limit: number = LIMITS.pageEntries): AsyncGenerator<SessionSummary[]> {
    const seen = new Set<string>(); let cursor: string | undefined;
    do {
      const result = await this.perform('sessions.list', { limit, ...(cwd ? { cwd } : {}), ...(cursor ? { cursor } : {}) });
      if (result.outcome !== 'accepted') throw new Error(this.notice);
      yield result.result.entries.filter(row => row.root === row.session);
      cursor = result.result.cursor;
      if (cursor && seen.has(cursor)) throw new Error('Session listing cursor repeated.');
      if (cursor) seen.add(cursor);
    } while (cursor && !this.closed);
  }

  async tree(): Promise<OperationResult<'session.tree'>> {
    const session = this.selected; if (!session) throw new Error('No session is attached.');
    for (let attempt = 0; attempt < 3 && !this.closed; attempt++) {
      const entries: OperationResult<'session.tree'>['entries'] = []; const seen = new Set<string>();
      let cursor: string | undefined; let revision = 0; let branch = ''; let retry = false;
      do {
        const response = await this.perform('session.tree', { limit: LIMITS.pageEntries, ...(cursor ? { cursor } : {}) }, session);
        if (response.outcome !== 'accepted') {
          if (response.error.code === 'resync_required') { retry = true; break; }
          throw new Error(this.notice);
        }
        if (entries.length && (revision !== response.result.revision || branch !== response.result.branch)) { retry = true; break; }
        revision = response.result.revision; branch = response.result.branch;
        entries.push(...response.result.entries);
        cursor = response.result.cursor;
        if (cursor && seen.has(cursor)) throw new Error('Session tree cursor repeated.');
        if (cursor) seen.add(cursor);
      } while (cursor && !this.closed);
      if (session !== this.selected || this.closed) throw new Error('Session selection changed.');
      if (!retry) return { entries, revision, branch };
    }
    throw new Error('Session tree changed while loading. Try again after the turn settles.');
  }

  async create(options: TuiSessionOptions): Promise<void> {
    const result = await this.perform('sessions.create', { cwd: options.cwd,
      ...(options.sessionDir ? { sessionDir: options.sessionDir } : {}),
      ...(options.extensions?.length ? { extensions: options.extensions } : {}), ...(options.config ? { config: options.config } : {}) });
    if (result.outcome !== 'accepted') throw new Error(this.notice);
    if (!this.closed) await this.attach(result.result.sessionId, 'new');
  }

  /** `reportMissing: false` leaves the notice unchanged when the daemon does not know the session. */
  attach(session: string, entry: SessionEntry = 'resume', reportMissing = true): Promise<void> {
    const operation = this.selection.then(() => this.attachSelected(session, entry, reportMissing));
    this.selection = operation.then(() => {}, () => {});
    return operation;
  }
  async reloadSession(session: string): Promise<boolean> {
    const accepted = (await this.perform('session.reload', {}, session)).outcome === 'accepted';
    if (accepted) this.setNotice('Reloaded extensions, skills, prompts, themes, and context files.');
    return accepted;
  }

  private async attachSelected(session: string, entry: SessionEntry, reportMissing: boolean): Promise<void> {
    if (this.closed || session === this.selected) return;
    const old = this.selected;
    const response = await this.client.attach(session);
    if (response.outcome !== 'accepted') {
      const message = outcomeText(response);
      if (reportMissing || response.error.code !== 'not_found') this.reportRejection(response);
      throw Object.assign(new Error(message), { code: response.error.code });
    }
    if (this.closed) return;
    this.selected = session; this.entered = entry; this.retained = undefined; this.sessionPromptEchoes = []; this.mergeSnapshot();
    // Switching sessions starts a fresh transcript; notes from before the first attachment join its end.
    const after = this.history.at(-1)?.id;
    this.sessionNotes = this.sessionNotes.flatMap(note => note.session ? [] : [{ ...note, session, ...(after ? { after } : {}) }]);
    this.emit();
    if (old && this.client.readAttachment(old)) await this.client.detach(old);
    await this.loadHistory();
  }

  async submit(text: string, requested: 'auto' | 'steer' | 'follow_up' = 'auto'): Promise<boolean> {
    const snapshot = this.snapshot;
    if (!text.trim() || this.submitting || this.closed) return false;
    if (this.client.status !== 'ready') { this.setNotice(`${unavailableText(this.client)} The input remains in the editor.`); return false; }
    if (!snapshot || this.state?.status !== 'live') { this.setNotice('Session is not ready. The input remains in the editor.'); return false; }
    const kind = requested === 'auto' ? (snapshot.run.state === 'idle' || snapshot.run.state === 'interrupted' ? 'prompt' : 'steer') : requested;
    const pending: SessionPromptEcho | undefined = kind === 'prompt' ? { after: this.history.at(-1)?.id, previousRun: snapshot.run.id, run: undefined,
      running: false, settled: false, accepted: false, echo: { text, timestamp: Date.now() } } : undefined;
    if (pending) this.sessionPromptEchoes.push(pending);
    this.submitting = true; this.emit();
    let accepted = false;
    try {
      const response = await this.perform(kind, { text }, snapshot.session);
      accepted = response.outcome === 'accepted';
      if (response.outcome === 'accepted' && pending) {
        pending.accepted = true;
        if ('runId' in response.result) pending.run = response.result.runId;
        this.reconcilePromptEchoes();
      }
      return accepted;
    } finally {
      if (!accepted && pending) this.sessionPromptEchoes = this.sessionPromptEchoes.filter(item => item !== pending);
      this.submitting = false; this.emit();
    }
  }

  cancel(): Promise<ResponseFor<'cancel'>> {
    if (!this.selected) return Promise.reject(new Error('No session is attached.'));
    return this.perform('cancel', this.snapshot?.run.id ? { runId: this.snapshot.run.id } : {}, this.selected);
  }

  async closeSession(): Promise<void> {
    if (!this.selected) return;
    const session = this.selected; const response = await this.perform('close', {}, session);
    if (response.outcome !== 'accepted') return;
    if (this.client.readAttachment(session)) await this.client.detach(session);
    if (this.selected === session) { this.selected = undefined; this.retained = undefined; this.sessionPromptEchoes = []; this.emit(); }
  }

  async reconnect(options: { replacing?: DaemonIdentity } = {}): Promise<void> {
    await this.client.connect(options);
    if (this.selected && this.state?.status === 'blocked') {
      const result = await this.client.retryAttach(this.selected);
      if (result.outcome !== 'accepted') throw new Error(outcomeText(result));
    }
    if (this.selected) await this.waitUntilLive(this.selected);
    await this.loadHistory();
    if (this.hostBlockedNotice && this.client.capabilities?.operations.includes('host.status')) {
      const status = await this.perform('host.status', {});
      if (status.outcome === 'accepted' && status.result.state === 'ready' && this.hostBlockedNotice) this.setNotice('Daemon reconnected.');
    }
  }

  perform<O extends Operation>(op: O, params: OperationParams<O>, session?: string): Promise<ResponseFor<O>> {
    if (this.closed) return Promise.reject(new Error('Terminal client is closed.'));
    if (this.client.status !== 'ready') return Promise.reject(new Error(unavailableText(this.client)));
    if (!this.client.capabilities?.operations.includes(op)) return Promise.reject(new Error(`The daemon does not support ${op}.`));
    const work = this.client.request(op, params, session ? { session } : {}).then(response => {
      if (response.outcome !== 'accepted') this.reportRejection(response, op !== 'host.status');
      return response;
    });
    this.pending.add(work);
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
    return work;
  }

  loadHistory(): Promise<void> {
    if (this.historyLoading) return this.historyLoading;
    const work = this.readHistory().catch(error => this.setNotice(errorText(error)));
    this.historyLoading = work;
    void work.then(() => { if (this.historyLoading === work) this.historyLoading = undefined; });
    return work;
  }

  dispose(): Promise<void> {
    return this.disposing ??= (async () => {
      this.closed = true; this.unsubscribe(); this.listeners.clear();
      try { if (this.selected && this.client.readAttachment(this.selected)) await this.client.detach(this.selected); }
      finally { this.client.close(); await Promise.allSettled([...this.pending]); await this.selection; if (this.historyLoading) await this.historyLoading; }
    })();
  }

  /** Every request fails while the daemon is blocked, so its refusal is reported once rather than per request. */
  private reportRejection(response: Exclude<ResponseFor<Operation>, { outcome: 'accepted' }>, explain = true): void {
    if (response.error.code !== 'host_blocked') { this.setNotice(outcomeText(response)); return; }
    if (this.hostBlockedNotice) return;
    this.setNotice(outcomeText(response), true);
    if (explain) void this.explainHostBlocked();
  }

  /** A refusal only says that the daemon is blocked; its status says where cleanup failed and whether forcing can retry it. */
  private async explainHostBlocked(): Promise<void> {
    if (!this.client.capabilities?.operations.includes('host.status')) return;
    const status = await this.perform('host.status', {}).catch(() => undefined);
    if (status?.outcome === 'accepted' && status.result.state === 'blocked' && this.hostBlockedNotice) {
      this.setNotice(`Daemon refuses new work. ${formatHostBlocked(status.result.blocked, { client: 'tui' })}`, true);
    }
  }

  private addNote(text: string, level: TranscriptNote['level'], status: boolean): void {
    const session = this.selected;
    const after = session && this.retained?.session === session ? this.retained.entries.at(-1)?.id : undefined;
    const note: SessionNote = { ...(session ? { session } : {}), ...(after ? { after } : {}), text, level, status };
    const last = this.sessionNotes.at(-1);
    if (last && last.session === session && last.after === after && ((status && last.status) || (last.level === level && last.text === text))) {
      this.sessionNotes[this.sessionNotes.length - 1] = note;
    } else this.sessionNotes.push(note);
  }

  /** Daemon notifications persist in the presentation; each new or changed one becomes a single note. */
  private collectNotifications(): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    if (this.notificationSession !== snapshot.session) { this.notificationSession = snapshot.session; this.seenNotifications.clear(); }
    const present = new Set<string>();
    for (const item of snapshot.presentation) {
      if (item.kind !== 'notification') continue;
      present.add(item.id);
      const key = `${item.level}\n${item.text}`;
      if (this.seenNotifications.get(item.id) === key) continue;
      this.seenNotifications.set(item.id, key); this.addNote(item.text, item.level, item.level === 'info');
    }
    for (const id of this.seenNotifications.keys()) if (!present.has(id)) this.seenNotifications.delete(id);
  }

  private mergeSnapshot(): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    const previous = this.retained;
    const last = previous?.entries.at(-1)?.id;
    if (previous?.branch === snapshot.branch && last === snapshot.history.entries.at(-1)?.id) {
      if (this.sessionPromptEchoes.some(pending => !pending.echo.message)) this.reconcilePromptEchoes();
      return;
    }
    if (!previous || previous.session !== snapshot.session || (previous.branch !== snapshot.branch && last && !snapshot.history.entries.some(row => row.id === last))) {
      this.retained = { session: snapshot.session, branch: snapshot.branch, entries: snapshot.history.entries };
    } else {
      const entries = new Map(previous.entries.map(row => [row.id, row]));
      for (const row of snapshot.history.entries) entries.set(row.id, row);
      this.retained = { session: snapshot.session, branch: snapshot.branch, entries: [...entries.values()] };
    }
    this.reconcilePromptEchoes();
  }

  private reconcilePromptEchoes(): void {
    if (!this.sessionPromptEchoes.length) return;
    const run = this.snapshot?.run;
    const active = run !== undefined && run.state !== 'idle' && run.state !== 'interrupted';
    const retained = new Set(this.history.map(message => message.id));
    const confirmed = new Set(this.sessionPromptEchoes.flatMap(({ echo }) => echo.message ? [echo.message] : []));
    this.sessionPromptEchoes = this.sessionPromptEchoes.filter(pending => {
      const { after, accepted, echo } = pending;
      if (echo.message) return retained.has(echo.message);
      const anchor = after === undefined ? -1 : this.history.findIndex(message => message.id === after);
      if (after !== undefined && anchor < 0) return false;
      if (active && (!pending.run || pending.run === run.id)) { pending.run = run.id; pending.running = true; }
      if (pending.run && run?.id && pending.run !== run.id && pending.previousRun !== run.id) pending.settled = true;
      if (pending.settled) return !accepted;
      const candidates = this.history.slice(anchor + 1).filter(message => !confirmed.has(message.id) && message.role === 'user');
      // Input hooks can rewrite prompts, but only their active run can supply a fallback match.
      const message = candidates.find(message => message.content.length === 1 && message.content[0]?.type === 'text' && message.content[0].text === echo.text)
        ?? (accepted && active && pending.run === run.id ? candidates[0] : undefined);
      if (message) { echo.message = message.id; confirmed.add(message.id); }
      else if (!active && (pending.running || pending.run !== undefined && pending.run === run?.id)) pending.settled = true;
      return !!message || !accepted || !pending.settled;
    });
    let remaining = this.sessionPromptEchoes.filter(pending => pending.echo.message).length;
    this.sessionPromptEchoes = this.sessionPromptEchoes.filter(pending => !pending.echo.message || remaining-- <= RETAINED_PROMPT_ECHOES);
  }

  private waitUntilLive(session: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const finish = (error?: Error) => { unsubscribe(); error ? reject(error) : resolve(); };
      const check = () => {
        const status = this.client.readAttachment(session)?.state.status;
        if (this.closed || this.selected !== session) finish(new Error('Session selection changed.'));
        else if (status === 'live') finish();
        else if (status === 'blocked') finish(new Error(`${this.blockedText} Use /reconnect before submitting.`));
      };
      unsubscribe = this.client.subscribe(check);
      check();
    });
  }

  private async readHistory(): Promise<void> {
    const session = this.selected;
    for (let attempt = 0; attempt < 3 && !this.closed && session === this.selected; attempt++) {
      const snapshot = this.snapshot; if (!snapshot) return;
      const entries = [...snapshot.history.entries]; const cursors = new Set<string>(); let cursor = snapshot.history.cursor; let retry = false;
      while (cursor && !this.closed && session === this.selected) {
        if (cursors.has(cursor)) throw new Error('Session history cursor repeated.');
        cursors.add(cursor);
        const result = await this.perform('session.history', { cursor, limit: LIMITS.pageEntries, revision: snapshot.revision, branch: snapshot.branch }, session);
        if (result.outcome !== 'accepted') {
          if (result.error.code === 'resync_required') { retry = true; break; }
          throw new Error(outcomeText(result));
        }
        entries.unshift(...result.result.entries);
        cursor = result.result.cursor;
      }
      if (this.closed || session !== this.selected) return;
      if (retry || this.snapshot?.branch !== snapshot.branch || this.snapshot.revision !== snapshot.revision) continue;
      this.retained = { session: snapshot.session, branch: snapshot.branch, entries }; this.reconcilePromptEchoes(); this.emit(); return;
    }
    if (!this.closed) this.setNotice('Session history changed while loading. Retry history after the current turn settles.');
  }

  private emit(): void {
    if (this.closed) return;
    this.collectNotifications();
    for (const listener of [...this.listeners]) {
      try { listener(); } catch (error) { this.notice = errorText(error); this.addNote(this.notice, 'error', false); }
    }
  }
}

/** Persistent connection status for the screen; undefined while connected. */
export function connectionText(client: Pick<Connection, 'status' | 'reconnection'>, now = Date.now()): string | undefined {
  if (client.status === 'ready') return undefined;
  const retry = client.reconnection;
  if (retry) return `Daemon disconnected · reconnecting in ${Math.max(1, Math.ceil((retry.retryAt - now) / 1000))}s · /reconnect to retry now`;
  if (client.status === 'connecting') return 'Connecting to daemon…';
  return `Daemon ${client.status}. Use /reconnect to retry.`;
}

function unavailableText(client: Pick<Connection, 'status' | 'reconnection'>): string {
  return client.reconnection || client.status === 'connecting' ? 'Daemon disconnected; reconnecting automatically. Use /reconnect to retry now.'
    : `Daemon ${client.status}. Use /reconnect to retry.`;
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function outcomeText(response: Exclude<ResponseFor<Operation>, { outcome: 'accepted' }>): string {
  if (response.error.code === 'host_blocked') return response.error.message;
  return response.outcome === 'indeterminate' ? `Outcome uncertain: ${response.error.message}` : `Rejected: ${response.error.message}`;
}
