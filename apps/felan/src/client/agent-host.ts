import type { AgentViewTranscript } from '../subagents/types.js';
import { COMPACTION_MESSAGE_TYPE, parseCompactionPresentation } from '@felan-ai/ext-session-compaction/view';
import type { Execution, Message } from '@felan-ai/session-protocol';
import type { AgentNavigatorHost, AgentNavigatorRecord } from '../subagents/agent-navigator.js';
import type { SessionClient } from './client.js';
import { projectedNativeMessage, projectedStreamingContent, projectedStreamingMessage } from './message-display.js';

type Client = Pick<SessionClient, 'getAttachment' | 'subscribe' | 'attach' | 'detach' | 'request' | 'status' | 'capabilities'>;
interface ChildAttachment { owned: boolean; id?: string; pending?: Promise<void> }
interface History { branch: string; entries: Message[]; loaded: boolean; loading?: Promise<void> }
type MutableRecord = { -readonly [K in keyof AgentNavigatorRecord]: AgentNavigatorRecord[K] };

export class ClientAgentHost implements AgentNavigatorHost {
  private records = new Map<string, AgentNavigatorRecord>();
  private readonly attachments = new Map<string, ChildAttachment>();
  private readonly histories = new Map<string, History>();
  private readonly projections = new Map<string, { key: string; value: AgentViewTranscript }>();
  private readonly listeners = new Set<() => void>();
  private readonly pending = new Set<Promise<void>>();
  private readonly cleanupErrors: unknown[] = [];
  private readonly unsubscribe: () => void;
  private selected: string | undefined;
  private attempted: string | undefined;
  private refreshPending = false;
  private refreshing: Promise<void> | undefined;
  private closed = false;
  private status = 'Loading agents…';
  private wasReady = false;
  private disposing: Promise<void> | undefined;

  constructor(private readonly client: Client, private readonly parent: string,
    private readonly settings: () => AgentViewTranscript['settings'],
    private readonly presentTool?: AgentNavigatorHost['toolPresentation']) {
    this.unsubscribe = client.subscribe(() => this.changed());
    this.changed();
  }

  getStatus(): string | undefined { return this.status || undefined; }
  toolPresentation(name: string): ReturnType<NonNullable<AgentNavigatorHost['toolPresentation']>> { return this.presentTool?.(name); }
  listLocalSubagents(): readonly AgentNavigatorRecord[] { return [...this.records.values()]; }
  getLocalSubagent(id: string): AgentNavigatorRecord | undefined { return this.records.get(id); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  selectAgent(id: string | undefined): void {
    if (this.closed || this.selected === id) return;
    this.selected = id;
    this.reconcile();
    if (id) {
      const row = this.records.get(id);
      if (row?.result === undefined && row?.state !== 'queued') this.track(this.readResult(id).catch(error => {
        if (!this.closed) { this.status = errorText(error); this.emit(); }
      }));
    }
    this.updateViews();
  }

  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    const work = this.readCatalog().catch(error => { this.status = errorText(error); this.emit(); });
    this.refreshing = work;
    const finished = () => {
      if (this.refreshing !== work) return;
      this.refreshing = undefined;
      if (this.refreshPending) {
        this.refreshPending = false;
        if (!this.closed && this.client.status === 'ready') void this.refresh();
      }
    };
    void work.then(finished, finished);
    return work;
  }

  reloadView(): void {
    if (this.closed) return;
    this.histories.clear(); this.projections.clear();
    void this.refresh(); this.updateViews();
  }

  async cancel(id: string, reason?: string): ReturnType<AgentNavigatorHost['cancel']> {
    if (this.closed) return unavailable();
    const response = await this.client.request('executions.cancel', { executionId: id, ...(reason === undefined ? {} : { reason }) }, { session: this.parent });
    if (response.outcome !== 'accepted') return unavailable(response.outcome === 'indeterminate' ? 'Stop outcome is uncertain. Reload agent state before retrying.' : response.error.message);
    this.updateRecord(viewRecord(response.result)); this.reconcile(); this.emit();
    return { ok: true, value: viewRecord(response.result) };
  }

  async steer(id: string, message: string): ReturnType<AgentNavigatorHost['steer']> {
    if (this.closed) return unavailable();
    const response = await this.client.request('executions.steer', { executionId: id, message }, { session: this.parent });
    if (response.outcome !== 'accepted') return unavailable(response.outcome === 'indeterminate' ? 'Message outcome is uncertain. Reload agent state before retrying.' : response.error.message);
    this.updateRecord(viewRecord(response.result)); this.emit();
    return { ok: true, value: viewRecord(response.result) };
  }

  dispose(): Promise<void> { return this.disposing ??= this.disposeOnce(); }

  private async disposeOnce(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.unsubscribe(); this.listeners.clear();
    for (const [session, attachment] of this.attachments) { this.attachments.delete(session); this.track(this.release(session, attachment)); }
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    if (this.refreshing) await this.refreshing;
    this.records.clear(); this.histories.clear(); this.projections.clear();
    if (this.cleanupErrors.length) throw new AggregateError(this.cleanupErrors, 'Agent view cleanup failed.');
  }

  private changed(): void {
    if (this.closed) return;
    const ready = this.client.status === 'ready';
    if (!ready) { this.wasReady = false; this.status = 'Agent connection unavailable.'; this.emit(); return; }
    if (!this.wasReady) { this.wasReady = true; this.attempted = undefined; this.reconcile(); }
    const root = this.client.getAttachment(this.parent)?.state;
    if (root?.status === 'live') {
      const revision = root.snapshot?.executionsGeneration ?? '';
      if (revision !== this.attempted) {
        this.attempted = revision;
        if (this.refreshing) this.refreshPending = true;
        else void this.refresh();
      }
    }
    this.updateViews();
  }

  private async readCatalog(): Promise<void> {
    if (this.client.status !== 'ready') throw new Error('Agent connection unavailable.');
    if (!this.client.capabilities?.operations.includes('executions.list')) throw new Error('This daemon does not support agent views.');
    for (let attempt = 0; attempt < 3; attempt++) {
      let cursor: string | undefined; const rows: Execution[] = []; const cursors = new Set<string>();
      const generation = this.client.getAttachment(this.parent)?.state.snapshot?.executionsGeneration;
      let retry = false;
      do {
        const response = await this.client.request('executions.list', { limit: 100, ...(cursor === undefined ? {} : { cursor }) }, { session: this.parent });
        if (this.closed) return;
        if (response.outcome !== 'accepted') {
          if (response.error.code === 'resync_required') { retry = true; break; }
          throw new Error(response.error.message);
        }
        rows.push(...response.result.items);
        if (rows.length > 4096 || new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('Execution catalog exceeds its bound or repeats an identity.');
        cursor = response.result.nextCursor;
        if (cursor) { if (cursors.has(cursor)) throw new Error('Execution catalog cursor did not advance.'); cursors.add(cursor); }
      } while (cursor);
      if (retry || generation !== this.client.getAttachment(this.parent)?.state.snapshot?.executionsGeneration) continue;
      this.refreshPending = false;
      const old = this.records; this.records = new Map();
      for (const row of rows) this.records.set(row.id, viewRecord(row, old.get(row.id)));
      this.status = ''; this.reconcile(); this.updateViews(); return;
    }
    throw new Error('Agent catalog changed while loading. Open the view again to retry.');
  }

  private updateRecord(row: AgentNavigatorRecord): void {
    if (this.closed) return;
    this.records.set(row.id, row);
  }

  private async readResult(id: string): Promise<void> {
    const response = await this.client.request('executions.read', { executionId: id }, { session: this.parent });
    if (this.closed || !this.records.has(id)) return;
    if (response.outcome !== 'accepted') { this.status = response.error.message; this.emit(); return; }
    this.updateRecord(viewRecord(response.result));

    this.reconcile(); this.updateViews();
  }

  private reconcile(): void {
    if (this.closed) return;
    const desired = new Set([...this.records.values()].filter(row => row.id === this.selected || row.state === 'running' || row.state === 'queued')
      .flatMap(row => row.session?.id ? [row.session?.id] : []));
    for (const [session, attachment] of this.attachments) if (!desired.has(session)) {
      this.attachments.delete(session); this.track(this.release(session, attachment));
      this.histories.delete(session); this.projections.delete(session);
    }
    for (const session of desired) {
      const previous = this.attachments.get(session);
      if (previous && (previous.pending || this.client.getAttachment(session))) continue;
      if (previous) this.attachments.delete(session);
      const present = this.client.getAttachment(session);
      const entry: ChildAttachment = { owned: !present, ...(present ? { id: present.id } : {}) };
      this.attachments.set(session, entry);
      if (present) continue;
      const connecting = this.client.attach(session);
      const localId = this.client.getAttachment(session)?.id;
      if (localId !== undefined) entry.id = localId;
      entry.pending = connecting.then(async response => {
        if (response.outcome !== 'accepted') throw new Error(response.error.message);
        if (this.closed || this.attachments.get(session) !== entry) await this.detachOwned(session, entry);
        else this.updateViews();
      }).catch(error => { if (this.closed) throw error; this.status = errorText(error); this.emit(); });
      this.track(entry.pending);
      void entry.pending.then(() => { delete entry.pending; });
    }
  }

  private async release(session: string, entry: ChildAttachment): Promise<void> {
    if (entry.pending) await entry.pending;
    await this.detachOwned(session, entry);
  }

  private async detachOwned(session: string, entry: ChildAttachment): Promise<void> {
    if (entry.owned && entry.id !== undefined && this.client.getAttachment(session)?.id === entry.id) await this.client.detach(session);
  }

  private updateViews(): void {
    if (this.closed) return;
    for (const [id, original] of this.records) {
      const state = original.session?.id ? this.client.getAttachment(original.session?.id)?.state : undefined;
      const snapshot = state?.snapshot;
      const row: MutableRecord = { ...original };
      if (snapshot && state?.status === 'live') {
        row.activity = snapshot.tools.some(tool => tool.state === 'running') ? `using ${snapshot.tools.filter(tool => tool.state === 'running').map(tool => tool.name).join(', ')}…`
          : snapshot.activeStreams.filter(stream => stream.kind === 'assistant').map(stream => stream.text).join('').split(/\r?\n/u).find(line => line.trim()) ?? 'thinking…';
        if (id === this.selected && original.session?.id) {
          const session = original.session?.id;
          let history = this.histories.get(session);
          if (!history) { history = { branch: snapshot.branch, entries: snapshot.history.entries, loaded: !snapshot.history.cursor }; this.histories.set(session, history); }
          const last = history.entries.at(-1)?.id;
          if (history.branch !== snapshot.branch && last && !snapshot.history.entries.some(item => item.id === last)) {
            history = { branch: snapshot.branch, entries: snapshot.history.entries, loaded: !snapshot.history.cursor }; this.histories.set(session, history);
          } else {
            const entries = new Map(history.entries.map(item => [item.id, item]));
            for (const item of snapshot.history.entries) entries.set(item.id, item);
            history.entries = [...entries.values()]; history.branch = snapshot.branch;
          }
          if (!history.loaded && !history.loading) {
            history.loading = this.loadHistory(session, history).catch(error => { this.status = errorText(error); history!.loaded = true; });
            this.track(history.loading.then(() => { delete history!.loading; this.updateViews(); }));
          }
          if (history.loaded) {
            const settings = this.settings();
            const key = `${snapshot.revision}:${snapshot.activeStreams.map(stream => `${stream.id}:${stream.offset}`).join(',')}:${history.entries.length}:${JSON.stringify(settings)}`;
            let projection = this.projections.get(session);
            if (projection?.key !== key) {
              const messages: AgentViewTranscript['messages'] = [];
              const fallbacks: NonNullable<AgentViewTranscript['fallbacks']> = [];
              const compactions: NonNullable<AgentViewTranscript['compactions']> = [];
              for (const item of history.entries) {
                try {
                  const native = projectedNativeMessage(item);
                  if (native) messages.push(native);
                  else if (item.customType === COMPACTION_MESSAGE_TYPE) {
                    const metadata = parseCompactionPresentation(item.details);
                    if (metadata.method) compactions.push({ message: messages.length, method: metadata.method });
                    messages.push({ role: 'compactionSummary', summary: plainMessage(item), tokensBefore: metadata.tokensBefore, timestamp: item.timestamp });
                  } else if (['user', 'assistant', 'tool'].includes(item.role)) fallbacks.push({ before: messages.length, text: `${item.role}:\n\n${plainMessage(item)}` });
                } catch (error) { this.status = errorText(error); fallbacks.push({ before: messages.length, text: `${item.role}:\n\n${plainMessage(item)}` }); }
              }
              let streaming: AgentViewTranscript['streaming'];
              try { streaming = projectedStreamingMessage(snapshot); } catch (error) { this.status = errorText(error); }
              const streamingContent = !streaming ? projectedStreamingContent(snapshot) : undefined;
              projection = { key, value: { agentId: id, cwd: snapshot.cwd, messages, pendingTools: snapshot.tools.filter(tool => tool.state === 'running').map(tool => tool.id),
                tools: snapshot.tools, settings, fallbacks, compactions, ...(streaming ? { streaming } : {}), ...(streamingContent ? { streamingContent } : {}) } };
              this.projections.set(session, projection);
            }
            row.projection = projection.value; delete row.transcriptStatus;
          } else { row.transcriptStatus = 'Loading transcript history…'; delete row.projection; }
        }
      } else if (original.session?.id) { row.transcriptStatus = state?.status === 'blocked' ? 'Transcript recovery is blocked.' : 'Waiting for the child connection…'; delete row.projection; }
      this.records.set(id, row);
    }
    this.emit();
  }

  private async loadHistory(session: string, target: History): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = this.client.getAttachment(session)?.state.snapshot;
      if (!snapshot || this.closed) return;
      let cursor = snapshot.history.cursor; let entries = [...snapshot.history.entries]; const seen = new Set<string>(); let retry = false;
      while (cursor) {
        if (seen.has(cursor)) throw new Error('Transcript cursor did not advance.'); seen.add(cursor);
        const response = await this.client.request('session.history', { cursor, revision: snapshot.revision, branch: snapshot.branch }, { session });
        if (this.closed || this.histories.get(session) !== target) return;
        if (response.outcome !== 'accepted') { if (response.error.code === 'resync_required') { retry = true; break; } throw new Error(response.error.message); }
        entries = [...response.result.entries, ...entries]; cursor = response.result.cursor;
      }
      if (retry || this.client.getAttachment(session)?.state.snapshot?.branch !== snapshot.branch) continue;
      target.entries = entries; target.branch = snapshot.branch; target.loaded = true; return;
    }
    throw new Error('Transcript changed while loading older entries. Reopen to retry.');
  }

  private track(promise: Promise<void>): void {
    this.pending.add(promise);
    void promise.then(() => this.pending.delete(promise), error => { this.pending.delete(promise); this.cleanupErrors.push(error); });
  }
  private emit(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch (error) { this.status = errorText(error); }
    }
  }
}

function unavailable(message = 'Agent view is closed.') { return { ok: false as const, error: { code: 'host_unavailable' as const, message } }; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function plainMessage(message: Message): string { return message.content.flatMap(part => part.type === 'text' || part.type === 'thinking' || part.type === 'tool_result'
  ? [part.text] : part.type === 'resource_link' ? [part.uri] : part.type === 'image' ? ['[Image]'] : []).join('\n'); }
function viewRecord(row: Execution, previous?: AgentNavigatorRecord): AgentNavigatorRecord {
  return { ...row, ...(previous?.session?.id === row.session?.id && previous?.projection ? { projection: previous.projection } : {}) };
}
