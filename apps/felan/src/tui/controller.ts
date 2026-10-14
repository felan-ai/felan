import { LIMITS, type Message, type Operation, type OperationParams, type OperationResult, type ResponseFor, type SessionSnapshot } from '@felan-ai/session-protocol';
import type { DaemonIdentity } from '@felan-ai/session-protocol';
import type { SessionClient } from '../client/client.js';

type Connection = Pick<SessionClient, 'status' | 'reconnection' | 'incompatibleActiveWork' | 'identity' | 'capabilities' | 'connect' | 'request' | 'attach' | 'retryAttach' | 'detach' | 'getAttachment' | 'getInteractions' | 'subscribe' | 'close'>;
type SessionSummary = OperationResult<'sessions.list'>['entries'][number];
export interface TuiSessionOptions {
  cwd: string;
  sessionId?: string;
  sessionDir?: string;
  continueRecent?: boolean;
  resume?: boolean;
  extensions?: string[];
  config?: OperationParams<'sessions.create'>['config'];
}

export class TuiSessionController {
  private selected: string | undefined;
  private retained: { session: string; branch: string; entries: Message[] } | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly unsubscribe: () => void;
  private closed = false;
  private submitting = false;
  private selection: Promise<void> = Promise.resolve();
  private historyLoading: Promise<void> | undefined;
  private disposing: Promise<void> | undefined;
  private connection: Connection['status'];
  private connectedBefore = false;
  private reconnectedNotice: ReturnType<typeof setTimeout> | undefined;
  notice = '';

  constructor(readonly client: Connection) {
    this.connection = client.status; this.connectedBefore = client.status === 'ready';
    this.unsubscribe = client.subscribe(() => { this.mergeSnapshot(); this.connectionChanged(); this.emit(); });
  }

  get sessionId(): string | undefined { return this.selected; }
  get state() { return this.selected ? this.client.getAttachment(this.selected)?.state : undefined; }
  get snapshot(): SessionSnapshot | undefined { return this.state?.snapshot; }
  get history(): readonly Message[] { return this.retained?.entries ?? []; }
  get busy(): boolean { return this.submitting; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  setNotice(message: string): void { if (!this.closed) { this.notice = message; this.emit(); } }

  async start(options: TuiSessionOptions, pick?: (sessions: readonly SessionSummary[]) => Promise<string | undefined>, connected?: () => Promise<void | boolean>): Promise<void> {
    await this.client.connect();
    if (this.closed) return;
    if (await connected?.() === false) return;
    if (this.closed) return;
    let id: string | undefined;
    if (options.resume || options.continueRecent || options.sessionId) {
      const sessions = await this.sessions(options.continueRecent ? options.cwd : undefined);
      if (options.resume) {
        if (!pick) throw new Error('Session selection requires an interactive picker.');
        id = await pick(sessions);
        if (!id) return;
      } else if (options.sessionId) {
        id = (sessions.find(row => row.session === options.sessionId) ?? sessions.find(row => row.session.startsWith(options.sessionId!)))?.session;
        if (!id) this.setNotice(`Session '${options.sessionId}' was not found. Starting a new session.`);
      } else id = sessions.filter(row => row.state === 'open').sort((a, b) => b.lastActivity - a.lastActivity)[0]?.session;
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

  async sessions(cwd?: string): Promise<SessionSummary[]> {
    const entries: SessionSummary[] = []; const seen = new Set<string>(); let cursor: string | undefined;
    do {
      const result = await this.perform('sessions.list', { limit: LIMITS.pageEntries, ...(cwd ? { cwd } : {}), ...(cursor ? { cursor } : {}) });
      if (result.outcome !== 'accepted') throw new Error(this.notice);
      entries.push(...result.result.entries.filter(row => row.root === row.session));
      cursor = result.result.cursor;
      if (cursor && seen.has(cursor)) throw new Error('Session listing cursor repeated.');
      if (cursor) seen.add(cursor);
    } while (cursor && !this.closed);
    return entries;
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
    const result = await this.perform('sessions.create', { cwd: options.cwd, source: 'tui', interactiveExtensions: true,
      ...(options.sessionDir ? { sessionDir: options.sessionDir } : {}),
      ...(options.extensions?.length ? { extensions: options.extensions } : {}), ...(options.config ? { config: options.config } : {}) });
    if (result.outcome !== 'accepted') throw new Error(this.notice);
    if (!this.closed) await this.attach(result.result.sessionId);
  }

  attach(session: string): Promise<void> {
    const operation = this.selection.then(() => this.attachSelected(session));
    this.selection = operation.then(() => {}, () => {});
    return operation;
  }
  async reloadSession(session: string): Promise<boolean> {
    const accepted = (await this.perform('session.reload', {}, session)).outcome === 'accepted';
    if (accepted) this.setNotice('Reloaded extensions, skills, prompts, themes, and context files.');
    return accepted;
  }

  private async attachSelected(session: string): Promise<void> {
    if (this.closed || session === this.selected) return;
    const old = this.selected;
    const response = await this.client.attach(session);
    if (response.outcome !== 'accepted') {
      this.setNotice(outcomeText(response));
      throw Object.assign(new Error(this.notice), { code: response.error.code });
    }
    if (this.closed) return;
    this.selected = session; this.retained = undefined; this.mergeSnapshot(); this.emit();
    if (old && this.client.getAttachment(old)) await this.client.detach(old);
    await this.loadHistory();
  }

  async submit(text: string, requested: 'auto' | 'steer' | 'follow_up' = 'auto'): Promise<boolean> {
    const snapshot = this.snapshot;
    if (!text.trim() || this.submitting || this.closed) return false;
    if (this.client.status !== 'ready') { this.setNotice(`${unavailableText(this.client)} The input remains in the editor.`); return false; }
    if (!snapshot || this.state?.status !== 'live') { this.setNotice('Session is not ready. The input remains in the editor.'); return false; }
    const kind = requested === 'auto' ? (snapshot.run.state === 'idle' || snapshot.run.state === 'interrupted' ? 'prompt' : 'steer') : requested;
    this.submitting = true; this.emit();
    try {
      return (await this.perform(kind, { text }, snapshot.session)).outcome === 'accepted';
    } finally { this.submitting = false; this.emit(); }
  }

  cancel(): Promise<ResponseFor<'cancel'>> {
    if (!this.selected) return Promise.reject(new Error('No session is attached.'));
    return this.perform('cancel', this.snapshot?.run.id ? { runId: this.snapshot.run.id } : {}, this.selected);
  }

  async closeSession(): Promise<void> {
    if (!this.selected) return;
    const session = this.selected; const response = await this.perform('close', {}, session);
    if (response.outcome !== 'accepted') return;
    if (this.client.getAttachment(session)) await this.client.detach(session);
    if (this.selected === session) { this.selected = undefined; this.retained = undefined; this.emit(); }
  }

  async reconnect(options: { replacing?: DaemonIdentity } = {}): Promise<void> {
    await this.client.connect(options);
    if (this.selected && this.state?.status === 'blocked') {
      const result = await this.client.retryAttach(this.selected);
      if (result.outcome !== 'accepted') throw new Error(outcomeText(result));
    }
    if (this.selected) await this.waitUntilLive(this.selected);
    await this.loadHistory();
  }

  perform<O extends Operation>(op: O, params: OperationParams<O>, session?: string): Promise<ResponseFor<O>> {
    if (this.closed) return Promise.reject(new Error('Terminal client is closed.'));
    if (this.client.status !== 'ready') return Promise.reject(new Error(unavailableText(this.client)));
    if (!this.client.capabilities?.operations.includes(op)) return Promise.reject(new Error(`The daemon does not support ${op}.`));
    const work = this.client.request(op, params, session ? { session } : {}).then(response => {
      if (response.outcome !== 'accepted') this.setNotice(outcomeText(response));
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
      this.closed = true; this.unsubscribe(); this.listeners.clear(); clearTimeout(this.reconnectedNotice);
      try { if (this.selected && this.client.getAttachment(this.selected)) await this.client.detach(this.selected); }
      finally { this.client.close(); await Promise.allSettled([...this.pending]); await this.selection; if (this.historyLoading) await this.historyLoading; }
    })();
  }

  private connectionChanged(): void {
    const previous = this.connection; this.connection = this.client.status;
    if (previous === 'ready' || this.connection !== 'ready') return;
    if (!this.connectedBefore) { this.connectedBefore = true; return; }
    this.notice = 'Reconnected';
    clearTimeout(this.reconnectedNotice);
    this.reconnectedNotice = setTimeout(() => { if (this.notice === 'Reconnected') this.setNotice(''); }, 3_000);
  }

  private mergeSnapshot(): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    const previous = this.retained;
    const last = previous?.entries.at(-1)?.id;
    if (previous?.branch === snapshot.branch && last === snapshot.history.entries.at(-1)?.id) return;
    if (!previous || previous.session !== snapshot.session || (previous.branch !== snapshot.branch && last && !snapshot.history.entries.some(row => row.id === last))) {
      this.retained = { session: snapshot.session, branch: snapshot.branch, entries: snapshot.history.entries };
    } else {
      const entries = new Map(previous.entries.map(row => [row.id, row]));
      for (const row of snapshot.history.entries) entries.set(row.id, row);
      this.retained = { session: snapshot.session, branch: snapshot.branch, entries: [...entries.values()] };
    }
  }

  private waitUntilLive(session: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const finish = (error?: Error) => { unsubscribe(); error ? reject(error) : resolve(); };
      const check = () => {
        const status = this.client.getAttachment(session)?.state.status;
        if (this.closed || this.selected !== session) finish(new Error('Session selection changed.'));
        else if (status === 'live') finish();
        else if (status === 'blocked') finish(new Error('Session recovery did not complete. Use /reconnect before submitting.'));
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
      this.retained = { session: snapshot.session, branch: snapshot.branch, entries }; this.emit(); return;
    }
    if (!this.closed) this.setNotice('Session history changed while loading. Retry history after the current turn settles.');
  }

  private emit(): void {
    if (this.closed) return;
    for (const listener of [...this.listeners]) { try { listener(); } catch (error) { this.notice = errorText(error); } }
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
  return response.outcome === 'indeterminate' ? `Outcome uncertain: ${response.error.message}` : `Rejected: ${response.error.message}`;
}
