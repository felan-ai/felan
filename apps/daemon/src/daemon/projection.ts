import { createHash, randomUUID } from 'node:crypto';
import { isConversationEntry } from './session-files.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getSupportedThinkingLevels, type AgentSession, type AgentSessionEvent, type SessionEntry } from '@felan-ai/agent-core';
import {
  CatalogSchema, CommandCatalogEntrySchema, LIMITS, ModelSchema, PresentationSchema, PromptSchema, ThinkingSchema, ToolCatalogEntrySchema, parseOperationResult, parseSchema, trimSnapshotLists, validatePrompt,
  type KnownSessionChange, type Message, type OperationResult, type Origin, type Presentation, type SessionEvent,
  type SessionSnapshot, type TextStreamEvent,
  MESSAGE_DISPLAY_ID, type ActiveMessageDisplay,
} from '@felan-ai/session-protocol';
import type { DaemonControlStore } from './control-store.js';
import type { ControlSessionMetadata } from './control-state.js';
import type { SessionBinding } from './session-lifecycle-contracts.js';
import { messageDisplay } from './message-display.js';
import { sessionTip } from './session-cursor.js';
import { catalogEntry, plainJson, sanitizeMessage, toolId, toolName, undisplayableMessage } from './message-sanitize.js';
import { boundSnapshot } from './snapshot-bounds.js';

export type ProjectionOutput = SessionEvent | TextStreamEvent;
type ProjectionExtras = Pick<SessionSnapshot, 'children' | 'processes' | 'interactions'>;
export interface LoadedSkill { name: string; description: string; filePath: string; scope: 'user' | 'project' | 'temporary' }
export interface ProjectionOptions {
  binding: SessionBinding;
  store: DaemonControlStore;
  extras(): ProjectionExtras;
  publish(event: ProjectionOutput): void;
  onError(error: unknown): void;
  canSettle?(): boolean;
  onRefresh?(): void;
  coalesceMs?: number;
  commandAvailable?(name: string): boolean;
}

type QueueItem = SessionSnapshot['queue'][number];
type QueuedMessage = Parameters<AgentSession['agent']['steer']>[0];
type Tool = SessionSnapshot['tools'][number];
type Stream = SessionSnapshot['activeStreams'][number];
type StreamState = { value: Stream; bytes: number; pendingHighSurrogate: string };
type CachedMessage = { id: string; liveId: string | undefined; originKey: string | undefined;
  project: SessionBinding['projectMessage']; source: unknown; message: Message; bytes: number };

export class SessionProjection {
  private readonly session: AgentSession;
  private readonly id: string;
  private readonly entryIds = new Set<string>();
  private scannedEntries = 0;
  private lastScannedEntryId: string | undefined;
  private readonly messageIds = new Map<string, string>();
  private readonly liveIds = new WeakMap<object, string>();
  private readonly origins = new Map<string, Origin>();
  private readonly messages = new Map<string, CachedMessage>();
  private messagesBytes = 0;
  private readonly tools = new Map<string, Tool>();
  private readonly dirtyTools = new Set<string>();
  private readonly streams = new Map<string, StreamState>();
  private streamsBytes = 0;
  private readonly completionOnly = new Map<string, SessionSnapshot['completionOnlyStreams'][number]>();
  private readonly omitted = new Map<string, string>();
  private readonly dirtyCompletionOnly = new Set<string>();
  private readonly presentation = new Map<string, Presentation>();
  private readonly completedStreams = new Set<string>();
  private queue: QueueItem[] = [];
  private readonly queued = new Map<string, { message: QueuedMessage; item: QueueItem }>();
  private readonly compactionQueue: QueueItem[] = [];
  private manualCompaction = false;
  private readonly queueContext = new AsyncLocalStorage<{ origin: Origin; ids: string[] }>();
  private readonly restoreQueueMethods: Array<() => void> = [];
  private queueLost = false;
  private queueObserved = false;
  private queueKey = digest([]);
  private queueNotice = '';
  private origin?: Origin;
  private assistant: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly unsubscribe: () => void;
  private catalogKey = '';
  private cachedCatalog!: { serialized: string; key: string; value: SessionSnapshot['catalog'] };
  private executionsGeneration: string | undefined;
  private runtimeRunId: string | undefined;
  private compacting = false;
  private compactionDirty = false;
  private activeDisplay: ActiveMessageDisplay | undefined;
  private displayDirty = false;

  constructor(private readonly options: ProjectionOptions) {
    this.session = options.binding.runtime.session;
    this.id = options.binding.sessionId;
    const saved = options.store.session(this.id);
    if (saved.projections.some(row => row.value.type === 'queue' && row.value.ids.length > 0) && this.session.pendingMessageCount === 0) {
      this.presentation.set('interrupted-queue', { id: 'interrupted-queue', kind: 'notification', level: 'warning', text: 'Pending queued turns were interrupted. Submit them again explicitly; no queued command was replayed.' });
    }
    for (const row of saved.projections) if (row.value.type === 'message') this.messageIds.set(row.value.entryId, row.value.id);
    // Absence is proved against all entries, not the current branch or a history page.
    const entries = this.session.sessionManager.getEntries();
    const allIds = new Set(entries.map(entry => entry.id));
    for (const entry of entries) this.entryIds.add(entry.id);
    this.scannedEntries = entries.length;
    this.lastScannedEntryId = entries.at(-1)?.id;
    const present = entries.filter(isMessageEntry).slice(-256).map(entry => ({ id: this.messageId(entry), entryId: entry.id }));
    const absentEntryIds = [...this.messageIds.keys()].filter(id => !allIds.has(id));
    if (absentEntryIds.length) options.store.reconcilePi(this.id, { present: [], absentEntryIds });
    if (present.length) options.store.reconcilePi(this.id, { present, absentEntryIds: [] });
    this.catalogKey = this.refreshCatalog().key;
    this.observePublicQueue();
    this.unsubscribe = this.session.subscribe(event => {
      try { this.receive(event); } catch (error) { options.onError(error); }
    });
  }

  setOrigin(origin: Origin): void { this.origin = structuredClone(origin); }

  get canObserveQueue(): boolean { return this.queueObserved && !this.queueLost; }
  get holdsCompactionInput(): boolean { return this.manualCompaction; }
  get compactionInputs(): readonly QueueItem[] { return this.compactionQueue; }

  beginManualCompaction(): void { this.manualCompaction = true; }
  endManualCompaction(): void { this.manualCompaction = false; }

  prepareCompactionInput(kind: QueueItem['kind'], prompt: QueueItem['prompt'], origin: Origin, requestId: string): () => string {
    const input = parseSchema(PromptSchema, prompt); validatePrompt(input);
    const item = { id: randomUUID(), kind, prompt: structuredClone(input), origin: structuredClone(origin) };
    const next = [...this.queued.values()].map(entry => entry.item).concat(this.compactionQueue.map(compactionPreview), compactionPreview(item));
    if (next.length > LIMITS.pageEntries || Buffer.byteLength(JSON.stringify(next)) > LIMITS.pageBytes / 2) {
      throw Object.assign(new Error('Compaction input queue is full.'), { code: 'busy' });
    }
    try { this.queueRestoreResult(requestId, item); }
    catch { throw Object.assign(new Error('Compaction input queue is full.'), { code: 'busy' }); }
    return () => { this.compactionQueue.push(item); this.refresh(); return item.id; };
  }

  queueRestoreResult(requestId: string, additional?: QueueItem): OperationResult<'queue.clear'> {
    const held = additional ? [...this.compactionQueue, additional] : this.compactionQueue;
    const result = { steering: [...this.session.getSteeringMessages(), ...held.filter(item => item.kind === 'steer').map(item => promptInput(item.prompt).text)],
      followUp: [...this.session.getFollowUpMessages(), ...held.filter(item => item.kind === 'follow_up').map(item => promptInput(item.prompt).text)] };
    if (result.steering.length + result.followUp.length > LIMITS.pageEntries) throw new Error('Too many queued messages.');
    const parsed = parseOperationResult('queue.clear', result);
    if (Buffer.byteLength(JSON.stringify({ v: 1, re: requestId, outcome: 'accepted', result: parsed })) > LIMITS.pageBytes / 2) throw new Error('Queued input exceeds the response byte limit.');
    return parsed;
  }

  takeCompactionInput(): QueueItem | undefined {
    const item = this.compactionQueue.shift(); this.refresh(); return item;
  }

  discardCompactionInput(): number {
    const count = this.compactionQueue.length; this.compactionQueue.length = 0; this.refresh(); return count;
  }

  async withQueueOrigin<T>(origin: Origin, effect: () => Promise<T>): Promise<{ value: T; ids: string[] }> {
    const context = { origin: structuredClone(origin), ids: [] as string[] };
    const value = await this.queueContext.run(context, effect);
    this.refresh();
    return { value, ids: [...context.ids] };
  }

  transitionForSafety(transition: Parameters<DaemonControlStore['transitionSessionForSafety']>[1], expectedRunId?: string): void {
    const previous = this.options.store.sessionMetadata(this.id);
    if (expectedRunId !== undefined && previous.run.id !== expectedRunId) return;
    const commit = this.options.store.transitionSessionForSafety(this.id, transition);
    if (commit.revisions[this.id] === undefined) return;
    const { value } = commit;
    const change: KnownSessionChange = transition === 'cancelling' || transition === 'idle'
      ? { type: 'run.updated', run: value.run }
      : { type: 'metadata.updated', title: value.title, state: value.state, residency: value.residency };
    this.options.publish({ v: 1, session: this.id, rev: value.revision, change });
  }

  settleRun(expectedRunId: string | undefined): void {
    if (expectedRunId === undefined || !this.session.isIdle || this.options.canSettle?.() === false) return;
    this.transitionForSafety('idle', expectedRunId);
  }

  /** Only a patch is durable; live views (tools, presentations, catalog, executions) take transient revisions. */
  /** Makes a draft visible to listings. Publishing keeps the client's revision sequence contiguous. */
  materialize(): void {
    const stored = this.options.store.sessionMetadata(this.id);
    this.publish({ type: 'metadata.updated', title: stored.title, state: stored.state, residency: stored.residency }, { draft: false });
  }
  publish(change: KnownSessionChange, patch?: Parameters<DaemonControlStore['updateSession']>[1]): void {
    const rev = patch ? this.options.store.updateSession(this.id, patch).value.revision : this.options.store.advanceTransientRevision(this.id);
    this.options.publish({ v: 1, session: this.id, rev, change });
  }

  setExecutionsGeneration(generation: string): void {
    if (this.executionsGeneration === generation) return;
    this.publish({ type: 'executions.changed', generation });
    this.executionsGeneration = generation;
  }

  refresh(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.refreshNow();
  }

  syncCursor(): void {
    const manager = this.session.sessionManager;
    const stored = this.options.store.sessionMetadata(this.id);
    const branch = manager.getLeafId() ?? this.id;
    const observedTip = sessionTip(manager);
    if (stored.branch === branch && stored.observedTip === observedTip) return;
    const commit = this.options.store.updateSession(this.id, { branch, observedTip });
    const history = this.history(undefined, commit.value.revision);
    this.options.publish({ v: 1, session: this.id, rev: commit.value.revision, change: { type: 'branch.updated', branch, history } });
  }

  private refreshNow(): void {
    this.options.store.owner.assertCurrent();
    if (this.compactionDirty) {
      const id = 'compaction:progress';
      if (!this.compacting || this.presentation.has(id) || this.presentation.size < LIMITS.pageEntries) {
        if (this.compacting) this.setPresentation({ id, kind: 'status', key: id, value: { kind: 'text', text: 'Compacting context…' }, fallback: 'Compacting context…' });
        // Clear before removing: a removal schedules a retry for whatever is still dirty.
        this.compactionDirty = false;
        if (!this.compacting && this.presentation.has(id)) this.setPresentation({ id, remove: true });
      }
    }
    for (const id of this.dirtyCompletionOnly) this.publishCompletionOnly(id);
    const manager = this.session.sessionManager;
    const entries = manager.getEntries();
    const start = entries.length >= this.scannedEntries && entries[this.scannedEntries - 1]?.id === this.lastScannedEntryId ? this.scannedEntries : 0;
    for (let index = start; index < entries.length; index++) {
      const entry = entries[index]!;
      if (this.entryIds.has(entry.id)) continue;
      if (!isMessageEntry(entry)) { this.entryIds.add(entry.id); continue; }
      if (isConversationEntry(entry) && this.options.store.sessionMetadata(this.id).draft) this.materialize();
      if (this.origin) this.origins.set(entry.id, this.origin);
      const { message } = this.message(entry);
      const commit = this.options.store.project(this.id, [{ type: 'message', id: message.id, entryId: entry.id, state: 'observed' }], true);
      this.entryIds.add(entry.id);
      for (const [id, stream] of this.streams) if (stream.value.message === message.id) this.removeStream(id);
      for (const [id, stream] of this.completionOnly) if (stream.message === message.id) this.completionOnly.delete(id);
      for (const [id, omittedMessage] of this.omitted) if (omittedMessage === message.id) this.omitted.delete(id);
      this.options.publish({ v: 1, session: this.id, rev: commit.value.revision, change: { type: 'message.completed', message } });
      if (this.activeDisplay?.message === message.id) { this.activeDisplay = undefined; this.displayDirty = true; }
    }
    this.scannedEntries = entries.length;
    this.lastScannedEntryId = entries.at(-1)?.id;
    this.flushDisplay();
    for (const id of this.dirtyTools) this.publish({ type: 'tool.updated', tool: this.tools.get(id)! });
    this.dirtyTools.clear();
    for (const [id, tool] of this.tools) if (this.tools.size > LIMITS.pageEntries && tool.state !== 'running') this.tools.delete(id);
    this.refreshQueue();
    const stored = this.options.store.sessionMetadata(this.id);
    const name = manager.getSessionName();
    const title = ((typeof name === 'string' ? name : '') as string & { toWellFormed(): string }).toWellFormed();
    if (stored.title !== title) this.publish({ type: 'metadata.updated', title, state: stored.state, residency: stored.residency }, { title });
    const selection = catalogEntry(() => ({ model: parseSchema(ModelSchema, this.session.model && { provider: this.session.model.provider, id: this.session.model.id }),
      thinking: parseSchema(ThinkingSchema, this.session.thinkingLevel) }))[0];
    if (selection && (digest(stored.model) !== digest(selection.model) || stored.thinking !== selection.thinking)) {
      this.publish({ type: 'model.updated', ...selection }, selection);
    }
    this.syncCursor();
    const catalog = this.refreshCatalog();
    if (this.catalogKey !== catalog.key) { this.publish({ type: 'catalog.updated', catalog: catalog.value }); this.catalogKey = catalog.key; }
    this.options.onRefresh?.();
  }

  catalog(): SessionSnapshot['catalog'] { return this.refreshCatalog().value; }

  /** Every skill the resource loader loaded, including those without an available `skill:` command. */
  skills(): LoadedSkill[] {
    return this.session.resourceLoader.getSkills().skills.map(skill => ({ name: skill.name, description: skill.description, filePath: skill.filePath, scope: skill.sourceInfo.scope }));
  }

  snapshot(): SessionSnapshot {
    this.refresh();
    const stored = this.options.store.sessionMetadata(this.id);
    if (!stored.model || !stored.thinking) throw new Error('Session has no selected model; select an available model before attaching.');
    const history = this.history(undefined, stored.revision);
    return boundSnapshot(trimSnapshotLists({
      session: this.id, root: stored.root, ...(stored.parent ? { parent: stored.parent } : {}),
      revision: stored.revision, cwd: stored.cwd, title: stored.title, state: stored.state, residency: stored.residency,
      branch: history.branch, history, model: stored.model, thinking: stored.thinking, run: stored.run,
      queue: this.queue, policy: stored.policy, catalog: this.cachedCatalog.value, ...this.options.extras(),
      tools: [...this.tools.values()], presentation: [...this.presentation.values()],
      ...(this.executionsGeneration ? { executionsGeneration: this.executionsGeneration } : {}),
      activeStreams: [...this.streams.values()].map(stream => stream.value), completionOnlyStreams: [...this.completionOnly.values()],
    }));
  }

  history(cursor?: string, revision = this.options.store.sessionMetadata(this.id).revision, limit: number = LIMITS.pageEntries): SessionSnapshot['history'] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIMITS.pageEntries) throw new Error('Invalid history page limit.');
    const branch = this.session.sessionManager.getLeafId() ?? this.id;
    const entries = this.session.sessionManager.getBranch().filter(isMessageEntry);
    let end = entries.length;
    if (cursor) {
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw new Error('resync_required'); }
      if (!Array.isArray(parsed) || parsed[0] !== this.id || parsed[1] !== revision || parsed[2] !== branch
        || !Number.isSafeInteger(parsed[3]) || parsed[3] < 0 || parsed[3] > end) throw new Error('resync_required');
      end = parsed[3] as number;
    }
    const page: Message[] = [];
    let bytes = 0;
    while (end > 0 && page.length < limit) {
      const { message, bytes: size } = this.message(entries[end - 1]!);
      if (bytes + size > LIMITS.pageBytes / 2) {
        if (!page.length) throw new Error('A transcript entry exceeds the history page budget.');
        break;
      }
      page.unshift(message); bytes += size; end--;
    }
    return { revision, branch, entries: page, ...(end ? { cursor: Buffer.from(JSON.stringify([this.id, revision, branch, end])).toString('base64url') } : {}) };
  }

  presentations(): readonly Presentation[] { return [...this.presentation.values()]; }

  setPresentation(value: Presentation | { id: string; remove: true }): void {
    if ('remove' in value) { this.presentation.delete(value.id); if (this.compactionDirty || this.displayDirty) this.schedule(); this.publish({ type: 'presentation.removed', id: value.id }); return; }
    const parsed = parseSchema(PresentationSchema, value);
    this.publish({ type: 'presentation.updated', presentation: parsed });
    this.presentation.set(parsed.id, parsed);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.unsubscribe();
    for (const restore of this.restoreQueueMethods.reverse()) restore();
    this.restoreQueueMethods.length = 0; this.queued.clear(); this.compactionQueue.length = 0;
    this.streams.clear(); this.streamsBytes = 0; this.completionOnly.clear(); this.omitted.clear(); this.dirtyCompletionOnly.clear();
  }

  private receive(event: AgentSessionEvent): void {
    if (this.disposed) return;
    if (event.type === 'compaction_start' || event.type === 'compaction_end') {
      this.compacting = event.type === 'compaction_start'; this.compactionDirty = true;
    }
    if (event.type === 'message_start') {
      const observed = [...this.queued].find(([, entry]) => entry.message === event.message);
      if (observed) {
        // Complete coalesced output under its old origin before the queued turn begins.
        this.refresh();
        this.queued.delete(observed[0]);
        const origin = observed[1].item.origin;
        this.setOrigin(origin);
        const run = { ...this.options.store.sessionMetadata(this.id).run, turnId: randomUUID(), origin };
        this.publish({ type: 'run.updated', run }, { run });
      }
    }
    if (event.type === 'agent_start') {
      const previous = this.options.store.sessionMetadata(this.id).run;
      const continuesRun = (previous.state === 'running' || previous.state === 'waiting' || previous.state === 'cancelling') && previous.id;
      const run = { state: previous.state === 'cancelling' ? 'cancelling' as const : 'running' as const, id: continuesRun || randomUUID(),
        ...(continuesRun && previous.turnId ? { turnId: previous.turnId } : {}), ...(this.origin ? { origin: this.origin } : {}) };
      this.publish({ type: 'run.updated', run }, { run });
      this.runtimeRunId = run.id;
    }
    if (event.type === 'agent_settled') {
      this.settleRun(this.runtimeRunId);
      this.runtimeRunId = undefined;
    }
    if (event.type === 'message_start' && event.message.role === 'assistant') {
      // Cursor changes clear client streams, so publish them before response deltas.
      this.syncCursor();
      this.assistant = randomUUID(); this.liveIds.set(event.message, this.assistant);
      const display = messageDisplay(event.message);
      this.activeDisplay = display?.kind === 'assistant' ? { message: this.assistant, display } : undefined;
      this.displayDirty = true;
      this.flushDisplay();
    }
    if (event.type === 'message_update' && (this.liveIds.get(event.message) ?? this.assistant)) {
      if (!this.activeDisplay) {
        const display = messageDisplay(event.message);
        if (display?.kind === 'assistant') {
          this.activeDisplay = { message: (this.liveIds.get(event.message) ?? this.assistant)!, display };
          this.displayDirty = true;
        }
      }
      const delta = event.assistantMessageEvent;
      if (delta.type === 'text_delta' || delta.type === 'thinking_delta') this.delta((this.liveIds.get(event.message) ?? this.assistant)!, delta.contentIndex, delta.type === 'text_delta' ? 'assistant' : 'thinking', delta.delta);
    }
    if (event.type === 'message_end' && event.message.role === 'assistant' && this.assistant) {
      this.liveIds.set(event.message, this.assistant); this.completedStreams.add(this.assistant); if (this.completedStreams.size > 256) this.completedStreams.delete(this.completedStreams.values().next().value!); this.assistant = undefined;
    }
    if (event.type === 'tool_execution_start') {
      const id = toolId(event.toolCallId);
      this.tools.set(id, { id, name: toolName(event.toolName), message: this.assistant ?? this.latestAssistantId(), state: 'running', output: '', truncated: false });
      this.dirtyTools.add(id);
    }
    if (event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
      const tool = this.tools.get(toolId(event.toolCallId));
      if (tool) {
        const result = event.type === 'tool_execution_update' ? event.partialResult : event.result;
        const output = (resultText(result) as string & { toWellFormed(): string }).toWellFormed();
        this.tools.set(tool.id, { ...tool, output: boundedText(output, LIMITS.statusTextBytes), truncated: Buffer.byteLength(output) > LIMITS.statusTextBytes,
          state: event.type === 'tool_execution_end' ? event.isError ? 'failed' : 'completed' : tool.state });
        this.dirtyTools.add(tool.id);
      }
    }
    this.schedule();
  }

  private schedule(): void {
    this.timer ??= setTimeout(() => { this.timer = undefined; try { this.refresh(); } catch (error) { this.options.onError(error); } }, this.options.coalesceMs ?? 25);
    this.timer.unref();
  }
  private flushDisplay(): void {
    if (!this.displayDirty) return;
    const id = MESSAGE_DISPLAY_ID;
    if (this.activeDisplay) {
      if (!this.presentation.has(id) && this.presentation.size >= LIMITS.pageEntries) return;
      this.setPresentation({ id, kind: 'message_display', data: this.activeDisplay });
      this.displayDirty = false;
    } else {
      this.displayDirty = false;
      if (this.presentation.has(id)) this.setPresentation({ id, remove: true });
    }
  }
  private latestAssistantId(): string {
    const entry = [...this.session.sessionManager.getEntries()].reverse().find(item => item.type === 'message' && item.message.role === 'assistant');
    return entry && isMessageEntry(entry) ? this.messageId(entry) : this.id;
  }
  private delta(message: string, index: number, kind: Stream['kind'], text: string): void {
    if (this.completedStreams.has(message)) return;
    const id = `${message}:${index}`;
    if (this.completionOnly.has(id) || this.omitted.has(id)) return;
    const old = this.streams.get(id);
    if (!old && this.streams.size + this.completionOnly.size >= LIMITS.activeStreams) {
      // Capped streams stay omitted so later deltas cannot publish an incomplete prefix.
      this.omitted.set(id, message); return;
    }
    text = (old?.pendingHighSurrogate ?? '') + text;
    const lastCodeUnit = text.charCodeAt(text.length - 1);
    const pendingHighSurrogate = lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? text.slice(-1) : '';
    // JSON frames cannot contain half a surrogate pair; completion replaces any withheld tail.
    if (pendingHighSurrogate) text = text.slice(0, -1);
    const offset = old?.value.offset ?? 0;
    let nextOffset = offset;
    let malformed = false;
    for (const point of text) {
      if (point.length === 1 && point >= '\ud800' && point <= '\udfff') { malformed = true; break; }
      nextOffset++;
    }
    const bytes = Buffer.byteLength(text);
    if (malformed || (old?.bytes ?? 0) + bytes > LIMITS.activeStreamBytes
      || this.streamsBytes + bytes > LIMITS.activeStreamsBytes) {
      this.removeStream(id);
      const stream: SessionSnapshot['completionOnlyStreams'][number] = { id, message, kind, reason: malformed ? 'lost' : 'limit' };
      this.completionOnly.set(id, stream); this.dirtyCompletionOnly.add(id);
      this.publishCompletionOnly(id);
      return;
    }
    this.streams.set(id, { value: { id, message, kind, text: (old?.value.text ?? '') + text, offset: nextOffset }, bytes: (old?.bytes ?? 0) + bytes,
      pendingHighSurrogate });
    this.streamsBytes += bytes;
    if (text) this.options.publish({ v: 1, session: this.id, stream: { id, message, kind, offset }, text });
  }
  private removeStream(id: string): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    this.streamsBytes -= stream.bytes;
    this.streams.delete(id);
  }
  private publishCompletionOnly(id: string): void {
    const stream = this.completionOnly.get(id);
    if (stream) this.publish({ type: 'stream.completion_only', stream });
    this.dirtyCompletionOnly.delete(id);
  }
  private refreshQueue(): void {
    if (this.queueObserved && this.session.isIdle && !this.session.agent.hasQueuedMessages()) { this.queued.clear(); this.queueLost = false; }
    const held = this.compactionQueue.map(compactionPreview);
    const next = [...this.queued.values()].map(entry => entry.item).concat(held);
    const key = digest(next);
    if (key !== this.queueKey) {
      const input = [...this.queued.values()].flatMap(entry => entry.message.role === 'user' ? [entry.item] : []).concat(held);
      const commit = this.options.store.project(this.id, [{ type: 'queue', ids: input.map(item => item.id), identity: { sha256: digest(input), bytes: Buffer.byteLength(JSON.stringify(input)) } }]);
      this.queue = next; this.queueKey = key;
      this.options.publish({ v: 1, session: this.id, rev: commit.value.revision, change: { type: 'queue.updated', queue: next } });
    }
    const notice = this.queueLost ? 'Native queue observation is incomplete. Queued input remains under runtime control; targeted editing is unavailable.' : '';
    if (notice !== this.queueNotice) {
      this.setPresentation(notice ? { id: 'queue-observation', kind: 'notification', level: 'warning', text: notice } : { id: 'queue-observation', remove: true });
      this.queueNotice = notice;
    }
  }

  private observePublicQueue(): void {
    const agent = this.session.agent;
    if (!agent || typeof agent.steer !== 'function' || typeof agent.followUp !== 'function') return;
    this.queueObserved = true;
    this.queueKey = digest([]);
    if (agent.hasQueuedMessages()) this.loseQueueObservation();
    const projection = this;
    for (const [name, kind] of [['steer', 'steer'], ['followUp', 'follow_up']] as const) {
      const original = agent[name];
      const wrapped: typeof original = function(this: AgentSession['agent'], message) {
        const result = original.call(this, message);
        if (this === agent && !projection.disposed && !projection.queueLost) {
          try { projection.observeEnqueue(message, kind); }
          catch { projection.loseQueueObservation(); }
        }
        return result;
      };
      agent[name] = wrapped;
      this.restoreQueueMethods.push(() => { if (agent[name] === wrapped) agent[name] = original; });
    }
    for (const name of ['clearSteeringQueue', 'clearFollowUpQueue', 'clearAllQueues'] as const) {
      const original = agent[name];
      const wrapped: typeof original = function(this: AgentSession['agent']) {
        const result = original.call(this);
        if (this === agent && !projection.disposed) {
          for (const [id, entry] of projection.queued) {
            if (name === 'clearAllQueues' || entry.item.kind === (name === 'clearSteeringQueue' ? 'steer' : 'follow_up')) projection.queued.delete(id);
          }
          projection.schedule();
        }
        return result;
      };
      agent[name] = wrapped;
      this.restoreQueueMethods.push(() => { if (agent[name] === wrapped) agent[name] = original; });
    }
  }

  private observeEnqueue(message: QueuedMessage, kind: QueueItem['kind']): void {
    if (message.role === 'custom' && !message.display) return;
    if (this.queued.size + this.compactionQueue.length >= LIMITS.pageEntries) { this.loseQueueObservation(); return; }
    const id = randomUUID(); const context = this.queueContext.getStore();
    const item: QueueItem = { id, kind, prompt: queuedPrompt(message), origin: context?.origin ?? { kind: 'automation', source: 'runtime' } };
    this.queued.set(id, { message, item });
    if (context) {
      if (context.ids.length >= LIMITS.pageEntries) this.loseQueueObservation();
      else context.ids.push(id);
    }
    if (Buffer.byteLength(JSON.stringify([...this.queued.values()].map(entry => entry.item).concat(this.compactionQueue.map(compactionPreview)))) > LIMITS.pageBytes / 2) this.loseQueueObservation();
    this.schedule();
  }

  private loseQueueObservation(): void {
    this.queueLost = true; this.queued.clear();
    this.schedule();
  }
  private refreshCatalog(): SessionProjection['cachedCatalog'] {
    const active = new Set(this.session.getActiveToolNames());
    const provenance = new Map(this.options.binding.tools.provenance.map(tool => [tool.name, tool]));
    const tools = this.session.getAllTools().flatMap(tool => catalogEntry(() => {
      const source = provenance.get(tool.name);
      return parseSchema(ToolCatalogEntrySchema, { name: tool.name, label: tool.name, description: tool.description ?? '', parameters: plainJson(tool.parameters),
        provenance: source?.source ?? 'external', source: boundedText(source?.sourceId ?? 'unknown', 128), active: active.has(tool.name) });
    }));
    const commands = this.session.extensionRunner.getRegisteredCommands().filter(command => this.options.commandAvailable?.(command.name) ?? false).flatMap(command => catalogEntry(() => parseSchema(CommandCatalogEntrySchema, { name: command.name,
      description: command.description ?? '', source: boundedText(command.sourceInfo?.path ?? 'extension', 128), ...(command.sourceInfo?.scope ? { scope: command.sourceInfo.scope } : {}), kind: 'extension' })));
    const skills = this.session.settingsManager?.getEnableSkillCommands() === false ? [] : this.session.resourceLoader.getSkills().skills;
    for (const skill of skills) {
      const name = `skill:${skill.name}`;
      if (!commands.some(command => command.name === name) && (this.options.commandAvailable?.(name) ?? false)) commands.push(...catalogEntry(() => parseSchema(CommandCatalogEntrySchema, { name,
        description: skill.description, source: boundedText(skill.filePath, 128), scope: skill.sourceInfo.scope, kind: 'skill' })));
    }
    const available = this.session.scopedModels.length ? this.session.scopedModels.map(({ model }) => model)
      : this.session.modelRuntime.getAvailableSnapshot();
    const models = available.flatMap(model => catalogEntry(() => parseSchema(CatalogSchema.properties.models.items,
      { provider: model.provider, id: model.id, label: model.name, thinking: getSupportedThinkingLevels(model) })));
    const raw = { tools, commands, models };
    const serialized = JSON.stringify(raw);
    if (this.cachedCatalog?.serialized === serialized) return this.cachedCatalog;
    const value = parseSchema(CatalogSchema, raw);
    return this.cachedCatalog = { serialized, key: digest(value), value };
  }
  private messageId(entry: SessionEntry): string {
    let id = this.messageIds.get(entry.id);
    if (!id) {
      id = entry.type === 'message' ? this.liveIds.get(entry.message) ?? entry.id : entry.id;
      this.messageIds.set(entry.id, id);
    }
    return id;
  }
  private message(entry: MessageEntry): CachedMessage {
    const id = this.messageId(entry);
    const origin = this.origins.get(entry.id);
    const originKey = JSON.stringify(origin);
    const project = this.options.binding.projectMessage;
    const source = entry.type === 'message' ? entry.message : entry;
    const liveId = entry.type === 'message' ? this.liveIds.get(entry.message) : undefined;
    // Pi can mutate a live message in place until message_end, even if it is already in history.
    const cacheable = !liveId || liveId !== this.assistant;
    const cached = this.messages.get(entry.id);
    if (cacheable && cached?.id === id && cached.liveId === liveId && cached.originKey === originKey
      && cached.project === project && cached.source === source) {
      this.messages.delete(entry.id); this.messages.set(entry.id, cached); return cached;
    }
    if (cached) { this.messages.delete(entry.id); this.messagesBytes -= cached.bytes; }
    let message = projectPiMessage(entry, id, origin);
    if (project) {
      const fallback = undisplayableMessage(message);
      try { message = sanitizeMessage(project(entry, message), fallback); }
      catch { message = fallback; }
    }
    const result = { id, liveId, originKey, project, source, message, bytes: Buffer.byteLength(JSON.stringify(message)) };
    if (cacheable && result.bytes <= LIMITS.pageBytes) {
      this.messages.set(entry.id, result); this.messagesBytes += result.bytes;
      while (this.messages.size > 2 * LIMITS.pageEntries || this.messagesBytes > LIMITS.pageBytes) {
        const [key, value] = this.messages.entries().next().value!;
        this.messages.delete(key); this.messagesBytes -= value.bytes;
      }
    }
    return result;
  }
}

type MessageEntry = Extract<SessionEntry, { type: 'message' | 'custom_message' | 'compaction' | 'branch_summary' }>;
// Custom messages marked hidden are model context only (memory, guidance); clients and publication never receive them.
function isMessageEntry(entry: SessionEntry): entry is MessageEntry {
  return entry.type === 'message' || entry.type === 'custom_message' && entry.display || entry.type === 'compaction' || entry.type === 'branch_summary';
}
/** @internal */
export function projectPiMessage(entry: MessageEntry, id = entry.id, origin?: Origin): Message {
  const role = entry.type === 'message' ? entry.message?.role : entry.type === 'custom_message' ? 'custom' : 'system';
  const fallback = undisplayableMessage({ id, entryId: entry.id, ...(entry.parentId ? { parentEntryId: entry.parentId } : {}),
    role: role === 'toolResult' ? 'tool' : ['user', 'assistant', 'system', 'custom'].includes(role) ? role as Message['role'] : 'custom',
    timestamp: Math.max(0, Date.parse(entry.timestamp) || 0) });
  try {
    const raw = entry.type === 'compaction' ? { role: 'system' as const, content: entry.summary }
      : entry.type === 'branch_summary' ? { role: 'system' as const, content: entry.summary } : entry.type === 'custom_message' ? { role: 'custom' as const, content: entry.content, customType: entry.customType, details: entry.details } : entry.message;
    const content: unknown[] = [];
    const rawContent = 'content' in raw ? raw.content : raw.role === 'bashExecution' ? `$ ${raw.command}\n${raw.output}` : 'summary' in raw ? raw.summary : undefined;
    if (typeof rawContent === 'string') content.push({ type: 'text', text: rawContent });
    else if (Array.isArray(rawContent)) for (const part of rawContent) {
      if (part.type === 'text') content.push({ type: 'text', text: part.text });
      else if (part.type === 'thinking') content.push({ type: 'thinking', text: part.thinking });
      else if (part.type === 'image') content.push({ type: 'image', mimeType: part.mimeType, data: part.data });
      else if (part.type === 'toolCall') content.push({ type: 'tool_call', id: part.id, name: part.name, arguments: part.arguments });
    }
    if (raw.role === 'toolResult') {
      const images = Array.isArray(rawContent) ? rawContent.filter(part => part.type === 'image').map(part => ({ type: 'image', mimeType: part.mimeType, data: part.data })) : [];
      content.splice(0, content.length, { type: 'tool_result', id: raw.toolCallId, text: resultText(raw), isError: raw.isError,
        ...(raw.details === undefined ? {} : { details: raw.details }) }, ...images);
    }
    const display = entry.type === 'message' ? messageDisplay(entry.message) : undefined;
    let details = 'details' in raw ? raw.details : undefined;
    if (raw.role === 'bashExecution') {
      details = { command: raw.command, exitCode: raw.exitCode ?? null, cancelled: raw.cancelled, truncated: raw.truncated,
        excludeFromContext: raw.excludeFromContext ?? false, ...(raw.fullOutputPath ? { fullOutputPath: raw.fullOutputPath } : {}) };
      content.splice(0, content.length, { type: 'text', text: raw.output });
    }
    return sanitizeMessage({ ...fallback, content,
      ...('customType' in raw ? { customType: raw.customType } : {}),
      ...(raw.role === 'bashExecution' ? { customType: 'bashExecution' } : {}),
      ...(details === undefined ? {} : { details }),
      ...(origin ? { origin } : {}),
    }, fallback, display);
  } catch { return fallback; }
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex'); }
export function boundedText(value: string, bytes: number): string {
  if (Buffer.byteLength(value) <= bytes) return value;
  let result = ''; let size = 0;
  for (const point of value) { size += Buffer.byteLength(point); if (size > bytes) break; result += point; }
  return result;
}
export function promptInput(prompt: QueueItem['prompt']) {
  const text = [prompt.text]; const images: NonNullable<Parameters<AgentSession['prompt']>[1]>['images'] = [];
  for (const part of prompt.attachments ?? []) {
    if (part.type === 'image') images.push({ type: 'image', data: part.data, mimeType: part.mimeType });
    else text.push(part.type === 'text' ? part.text : `${part.name ?? 'Resource'}: ${part.uri}${part.description ? `\n${part.description}` : ''}`);
  }
  return { text: text.join('\n'), images };
}
function queuedPrompt(message: QueuedMessage): QueueItem['prompt'] {
  if (message.role === 'user' || message.role === 'custom') {
    try {
      const { content } = message;
      const prompt = parseSchema(PromptSchema, typeof content === 'string' ? { text: content } : { text: '', attachments: content.map(part => part.type === 'text'
        ? { type: 'text', text: part.text } : { type: 'image', mimeType: part.mimeType, data: part.data }) });
      validatePrompt(prompt);
      if (Buffer.byteLength(JSON.stringify(prompt)) <= LIMITS.statusTextBytes) return prompt;
    } catch {}
  }
  const content = 'content' in message ? message.content : undefined;
  const parts = typeof content === 'string' ? [content] : Array.isArray(content)
    ? content.map(part => part.type === 'text' ? part.text : part.type === 'image' ? '[image omitted]' : '') : [];
  const text = (parts.filter(Boolean).join('\n') as string & { toWellFormed(): string }).toWellFormed();
  const preview = boundedText(text, LIMITS.statusTextBytes);
  return { text: preview === text ? text || `[${message.role} message]` : `${preview}…` };
}
function compactionPreview(item: QueueItem): QueueItem {
  if (Buffer.byteLength(JSON.stringify(item.prompt)) <= LIMITS.statusTextBytes) return item;
  const parts = [item.prompt.text, ...(item.prompt.attachments ?? []).map(part => part.type === 'text' ? part.text
    : part.type === 'image' ? '[image omitted]' : `${part.name ?? 'Resource'}: ${part.uri}${part.description ? `\n${part.description}` : ''}`)];
  const text = parts.filter(Boolean).join('\n'); const preview = boundedText(text, LIMITS.statusTextBytes);
  return { ...item, prompt: { text: preview === text ? text : `${preview}…` } };
}
function resultText(value: unknown): string {
  if (!value || typeof value !== 'object' || !('content' in value) || !Array.isArray(value.content)) return '';
  return value.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
}
export function profilePolicy(session: ControlSessionMetadata) {
  return { mode: session.policy.effective, generation: session.policy.generation };
}
