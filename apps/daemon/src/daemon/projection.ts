import { createHash, randomUUID } from 'node:crypto';
import { isConversationEntry } from './session-files.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getSupportedThinkingLevels, type AgentSession, type AgentSessionEvent, type SessionEntry } from '@felan-ai/agent-core';
import {
  CatalogSchema, JsonValueSchema, LIMITS, MessageSchema, OPERATION_CATALOG, PresentationSchema, PromptSchema, parseSchema, parseSessionSnapshot, trimSnapshotLists, validateBase64, validatePrompt,
  type KnownSessionChange, type Message, type Origin, type Presentation, type SessionEvent,
  type SessionSnapshot, type TextStreamEvent,
  MESSAGE_DISPLAY_KEY, MESSAGE_DISPLAY_ID, type ActiveMessageDisplay,
} from '@felan-ai/session-protocol';
import type { DaemonControlStore } from './control-store.js';
import type { ControlSession, ControlSessionMetadata } from './control-state.js';
import type { SessionBinding } from './session-lifecycle-contracts.js';
import { messageDisplay } from './message-display.js';
import { sessionTip } from './session-cursor.js';

export type ProjectionOutput = SessionEvent | TextStreamEvent;
export type ProjectionExtras = Pick<SessionSnapshot, 'children' | 'processes' | 'interactions'>;
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
type Tool = SessionSnapshot['tools'][number];
type Stream = SessionSnapshot['activeStreams'][number];

export class SessionProjection {
  private readonly session: AgentSession;
  private readonly id: string;
  private readonly entryIds = new Set<string>();
  private readonly messageIds = new Map<string, string>();
  private readonly liveIds = new WeakMap<object, string>();
  private readonly origins = new Map<string, Origin>();
  private readonly tools = new Map<string, Tool>();
  private readonly dirtyTools = new Set<string>();
  private readonly streams = new Map<string, Stream>();
  private readonly completionOnly = new Map<string, SessionSnapshot['completionOnlyStreams'][number]>();
  private readonly dirtyCompletionOnly = new Set<string>();
  private readonly presentation = new Map<string, Presentation>();
  private readonly completedStreams = new Set<string>();
  private queue: QueueItem[] = [];
  private readonly queued = new Map<string, { message: object; kind: QueueItem['kind']; item?: QueueItem }>();
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
    const present = entries.filter(isMessageEntry).slice(-256).map(entry => ({ id: this.messageId(entry), entryId: entry.id }));
    const absentEntryIds = [...this.messageIds.keys()].filter(id => !allIds.has(id));
    if (absentEntryIds.length) options.store.reconcilePi(this.id, { present: [], absentEntryIds });
    if (present.length) options.store.reconcilePi(this.id, { present, absentEntryIds: [] });
    this.catalogKey = digest(this.catalog());
    this.observePublicQueue();
    this.unsubscribe = this.session.subscribe(event => {
      try { this.receive(event); } catch (error) { options.onError(error); }
    });
  }

  setOrigin(origin: Origin): void { this.origin = structuredClone(origin); }

  get canObserveQueue(): boolean { return this.queueObserved && !this.queueLost; }

  async withQueueOrigin<T>(origin: Origin, effect: () => Promise<T>): Promise<{ value: T; ids: string[] }> {
    if (!this.canObserveQueue) throw new Error('Queue observation is unavailable.');
    const context = { origin: structuredClone(origin), ids: [] as string[] };
    const value = await this.queueContext.run(context, effect);
    this.refresh();
    return { value, ids: [...context.ids] };
  }

  transitionForSafety(transition: Parameters<DaemonControlStore['transitionSessionForSafety']>[1], expectedRunId?: string): void {
    const previous = this.options.store.session(this.id);
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
    const stored = this.options.store.session(this.id);
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
    const stored = this.options.store.session(this.id);
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
        else if (this.presentation.has(id)) this.setPresentation({ id, remove: true });
        this.compactionDirty = false;
      }
    }
    for (const id of this.dirtyCompletionOnly) this.publishCompletionOnly(id);
    const manager = this.session.sessionManager;
    for (const entry of manager.getEntries()) {
      if (this.entryIds.has(entry.id)) continue;
      if (!isMessageEntry(entry)) { this.entryIds.add(entry.id); continue; }
      if (isConversationEntry(entry) && this.options.store.session(this.id).draft) this.materialize();
      if (this.origin) this.origins.set(entry.id, this.origin);
      const message = this.message(entry);
      const commit = this.options.store.project(this.id, [{ type: 'message', id: message.id, entryId: entry.id, state: 'observed' }]);
      this.entryIds.add(entry.id);
      for (const [id, stream] of this.streams) if (stream.message === message.id) this.streams.delete(id);
      for (const [id, stream] of this.completionOnly) if (stream.message === message.id) this.completionOnly.delete(id);
      this.options.publish({ v: 1, session: this.id, rev: commit.value.revision, change: { type: 'message.completed', message } });
      if (this.activeDisplay?.message === message.id) { this.activeDisplay = undefined; this.displayDirty = true; }
    }
    this.flushDisplay();
    for (const id of this.dirtyTools) this.publish({ type: 'tool.updated', tool: this.tools.get(id)! });
    this.dirtyTools.clear();
    for (const [id, tool] of this.tools) if (this.tools.size > LIMITS.pageEntries && tool.state !== 'running') this.tools.delete(id);
    this.refreshQueue();
    const stored = this.options.store.session(this.id);
    const title = manager.getSessionName() ?? '';
    if (stored.title !== title) this.publish({ type: 'metadata.updated', title, state: stored.state, residency: stored.residency }, { title });
    const model = this.session.model && { provider: this.session.model.provider, id: this.session.model.id };
    const thinking = this.session.thinkingLevel;
    if (model && (digest(stored.model) !== digest(model) || stored.thinking !== thinking)) this.publish({ type: 'model.updated', model, thinking }, { model, thinking });
    this.syncCursor();
    const catalog = this.catalog();
    if (this.catalogKey !== digest(catalog)) { this.publish({ type: 'catalog.updated', catalog }); this.catalogKey = digest(catalog); }
    this.options.onRefresh?.();
  }

  snapshot(): SessionSnapshot {
    this.refresh();
    const stored = this.options.store.session(this.id);
    if (!stored.model || !stored.thinking) throw new Error('Session has no selected model; select an available model before attaching.');
    const history = this.history(undefined, stored.revision);
    return parseSessionSnapshot(trimSnapshotLists({
      session: this.id, root: stored.root, ...(stored.parent ? { parent: stored.parent } : {}),
      revision: stored.revision, cwd: stored.cwd, title: stored.title, state: stored.state, residency: stored.residency,
      branch: history.branch, history, model: stored.model, thinking: stored.thinking, run: stored.run,
      queue: this.queue, policy: stored.policy, catalog: this.catalog(), ...this.options.extras(),
      tools: [...this.tools.values()], presentation: [...this.presentation.values()],
      ...(this.executionsGeneration ? { executionsGeneration: this.executionsGeneration } : {}),
      activeStreams: [...this.streams.values()], completionOnlyStreams: [...this.completionOnly.values()],
    }));
  }

  history(cursor?: string, revision = this.options.store.session(this.id).revision, limit: number = LIMITS.pageEntries): SessionSnapshot['history'] {
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
      const message = this.message(entries[end - 1]!);
      const size = Buffer.byteLength(JSON.stringify(message));
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
    this.restoreQueueMethods.length = 0; this.queued.clear();
    this.streams.clear(); this.completionOnly.clear(); this.dirtyCompletionOnly.clear();
  }

  private receive(event: AgentSessionEvent): void {
    if (this.disposed) return;
    if (event.type === 'compaction_start' || event.type === 'compaction_end') {
      this.compacting = event.type === 'compaction_start'; this.compactionDirty = true;
    }
    if (event.type === 'message_start') {
      const observed = [...this.queued].find(([, entry]) => entry.message === event.message);
      if (observed) this.queued.delete(observed[0]);
    }
    if (event.type === 'agent_start') {
      const previous = this.options.store.session(this.id).run;
      const run = { state: 'running' as const, id: (previous.state === 'running' || previous.state === 'waiting') && previous.id ? previous.id : randomUUID(), ...(this.origin ? { origin: this.origin } : {}) };
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
      this.tools.set(event.toolCallId, { id: event.toolCallId, name: event.toolName, message: this.assistant ?? this.latestAssistantId(), state: 'running', output: '', truncated: false });
      this.dirtyTools.add(event.toolCallId);
    }
    if (event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
      const tool = this.tools.get(event.toolCallId);
      if (tool) {
        const result = event.type === 'tool_execution_update' ? event.partialResult : event.result;
        const output = resultText(result);
        tool.output = boundedText(output, LIMITS.statusTextBytes); tool.truncated = Buffer.byteLength(output) > LIMITS.statusTextBytes;
        if (event.type === 'tool_execution_end') tool.state = event.isError ? 'failed' : 'completed';
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
    } else if (this.presentation.has(id)) this.setPresentation({ id, remove: true });
    this.displayDirty = false;
  }
  private latestAssistantId(): string {
    const entry = [...this.session.sessionManager.getEntries()].reverse().find(item => item.type === 'message' && item.message.role === 'assistant');
    return entry && isMessageEntry(entry) ? this.messageId(entry) : this.id;
  }
  private delta(message: string, index: number, kind: Stream['kind'], text: string): void {
    if (this.completedStreams.has(message)) return;
    const id = `${message}:${index}`;
    if (this.completionOnly.has(id)) return;
    const old = this.streams.get(id);
    const prefix = (old?.text ?? '') + text;
    if ((!old && this.streams.size + this.completionOnly.size >= LIMITS.activeStreams)
      || Buffer.byteLength(prefix) > LIMITS.activeStreamBytes
      || [...this.streams.values()].reduce((n, item) => n + Buffer.byteLength(item.text), 0) + Buffer.byteLength(text) > LIMITS.activeStreamsBytes) {
      this.streams.delete(id);
      if (this.streams.size + this.completionOnly.size >= LIMITS.activeStreams) throw new Error('Active stream capacity exceeded.');
      const stream = { id, message, kind, reason: 'limit' as const };
      this.completionOnly.set(id, stream); this.dirtyCompletionOnly.add(id);
      this.publishCompletionOnly(id);
      return;
    }
    const offset = old?.offset ?? 0;
    this.streams.set(id, { id, message, kind, text: prefix, offset: offset + [...text].length });
    this.options.publish({ v: 1, session: this.id, stream: { id, message, kind, offset }, text });
  }
  private publishCompletionOnly(id: string): void {
    const stream = this.completionOnly.get(id);
    if (stream) this.publish({ type: 'stream.completion_only', stream });
    this.dirtyCompletionOnly.delete(id);
  }
  private refreshQueue(): void {
    if (this.queueObserved && this.session.isIdle && !this.session.agent.hasQueuedMessages()) { this.queued.clear(); this.queueLost = false; }
    const next = [...this.queued.values()].flatMap(entry => entry.item ? [entry.item] : []);
    const key = digest(next);
    if (key !== this.queueKey) {
      const commit = this.options.store.project(this.id, [{ type: 'queue', ids: next.map(item => item.id), identity: { sha256: digest(next), bytes: Buffer.byteLength(JSON.stringify(next)) } }]);
      this.queue = next; this.queueKey = key;
      this.options.publish({ v: 1, session: this.id, rev: commit.value.revision, change: { type: 'queue.updated', queue: next } });
    }
    const notice = this.queueLost ? 'Native queue observation is incomplete. Queued input remains under runtime control; targeted editing is unavailable.'
      : [...this.queued.values()].some(entry => !entry.item) ? 'Some native queued input cannot be represented as a client prompt. It remains under runtime control.' : '';
    if (notice !== this.queueNotice) {
      this.setPresentation(notice ? { id: 'unrepresented-queue', kind: 'notification', level: 'warning', text: notice } : { id: 'unrepresented-queue', remove: true });
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
            if (name === 'clearAllQueues' || entry.kind === (name === 'clearSteeringQueue' ? 'steer' : 'follow_up')) projection.queued.delete(id);
          }
          projection.schedule();
        }
        return result;
      };
      agent[name] = wrapped;
      this.restoreQueueMethods.push(() => { if (agent[name] === wrapped) agent[name] = original; });
    }
  }

  private observeEnqueue(message: Parameters<AgentSession['agent']['steer']>[0], kind: QueueItem['kind']): void {
    if (this.queued.size >= LIMITS.pageEntries) { this.loseQueueObservation(); return; }
    const id = randomUUID(); const context = this.queueContext.getStore();
    let item: QueueItem | undefined;
    if (message.role === 'user') {
      try {
        const prompt = typeof message.content === 'string' ? { text: message.content }
          : { text: '', attachments: message.content.map(part => part.type === 'text' ? { type: 'text', text: part.text }
            : { type: 'image', mimeType: part.mimeType, data: part.data }) };
        const parsed = parseSchema(PromptSchema, prompt); validatePrompt(parsed);
        item = { id, kind, prompt: parsed, origin: context?.origin ?? { kind: 'automation', source: 'runtime' } };
      } catch { /* Unrepresentable queued input stays untouched in the native runtime. */ }
    }
    this.queued.set(id, { message, kind, ...(item ? { item } : {}) });
    if (context) {
      if (context.ids.length >= LIMITS.pageEntries) this.loseQueueObservation();
      else context.ids.push(id);
    }
    if (Buffer.byteLength(JSON.stringify([...this.queued.values()].flatMap(entry => entry.item ? [entry.item] : []))) > LIMITS.pageBytes / 2) this.loseQueueObservation();
    this.schedule();
  }

  private loseQueueObservation(): void {
    this.queueLost = true; this.queued.clear();
    this.schedule();
  }
  private catalog(): SessionSnapshot['catalog'] {
    const active = new Set(this.session.getActiveToolNames());
    const provenance = new Map(this.options.binding.tools.provenance.map(tool => [tool.name, tool]));
    const tools = this.session.getAllTools().map(tool => {
      const source = provenance.get(tool.name);
      return { name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters,
        provenance: source?.source ?? 'external', source: boundedText(source?.sourceId ?? 'unknown', 128), active: active.has(tool.name) };
    });
    const commands: SessionSnapshot['catalog']['commands'] = this.session.extensionRunner.getRegisteredCommands().filter(command => this.options.commandAvailable?.(command.name) ?? false).map(command => ({ name: command.name,
      description: command.description ?? '', source: boundedText(command.sourceInfo?.path ?? 'extension', 128), scope: command.sourceInfo?.scope, kind: 'extension' as const }));
    const skills = this.session.settingsManager?.getEnableSkillCommands() === false ? [] : this.session.resourceLoader.getSkills().skills;
    for (const skill of skills) {
      const name = `skill:${skill.name}`;
      if (!commands.some(command => command.name === name) && (this.options.commandAvailable?.(name) ?? false)) commands.push({ name,
        description: skill.description, source: boundedText(skill.filePath, 128), scope: skill.sourceInfo.scope, kind: 'skill' });
    }
    const available = this.session.scopedModels.length ? this.session.scopedModels.map(({ model }) => model)
      : this.session.modelRuntime.getAvailableSnapshot();
    const models = available.map(model => ({ provider: model.provider, id: model.id, label: model.name, thinking: getSupportedThinkingLevels(model) }));
    return parseSchema(CatalogSchema, { tools, commands, models });
  }
  private messageId(entry: SessionEntry): string {
    let id = this.messageIds.get(entry.id);
    if (!id) {
      id = entry.type === 'message' ? this.liveIds.get(entry.message) ?? entry.id : entry.id;
      this.messageIds.set(entry.id, id);
    }
    return id;
  }
  private message(entry: MessageEntry): Message {
    const message = projectPiMessage(entry, this.messageId(entry), this.origins.get(entry.id));
    const project = this.options.binding.projectMessage;
    if (!project) return message;
    const value = parseSchema(MessageSchema, project(entry, message));
    if (value.id !== message.id || value.entryId !== message.entryId) throw new Error('Message projection changed canonical identity.');
    return value;
  }
}

type MessageEntry = Extract<SessionEntry, { type: 'message' | 'custom_message' | 'compaction' | 'branch_summary' }>;
function isMessageEntry(entry: SessionEntry): entry is MessageEntry { return entry.type === 'message' || entry.type === 'custom_message' || entry.type === 'compaction' || entry.type === 'branch_summary'; }
export function projectPiMessage(entry: MessageEntry, id = entry.id, origin?: Origin): Message {
  const raw = entry.type === 'compaction' ? { role: 'system' as const, content: entry.summary }
    : entry.type === 'branch_summary' ? { role: 'system' as const, content: entry.summary } : entry.type === 'custom_message' ? { role: 'custom' as const, content: entry.content, customType: entry.customType, details: entry.details } : entry.message;
  const content: Message['content'] = [];
  const rawContent = 'content' in raw ? raw.content : raw.role === 'bashExecution' ? `$ ${raw.command}\n${raw.output}` : 'summary' in raw ? raw.summary : undefined;
  if (typeof rawContent === 'string') content.push({ type: 'text', text: rawContent });
  else if (Array.isArray(rawContent)) for (const part of rawContent) {
    if (part.type === 'text') content.push({ type: 'text', text: part.text });
    else if (part.type === 'thinking') content.push({ type: 'thinking', text: part.thinking });
    else if (part.type === 'image') {
      validateBase64(part.data);
      content.push({ type: 'image', mimeType: part.mimeType as 'image/png', data: part.data });
    }
    else if (part.type === 'toolCall') content.push({ type: 'tool_call', id: part.id, name: part.name, arguments: parseSchema(JsonValueSchema, part.arguments) });
  }
  if (raw.role === 'toolResult') {
    const images = content.filter(part => part.type === 'image');
    content.splice(0, content.length, { type: 'tool_result', id: raw.toolCallId, text: resultText(raw), isError: raw.isError,
      ...(raw.details === undefined ? {} : { details: parseSchema(JsonValueSchema, raw.details) }) }, ...images);
  }
  const display = entry.type === 'message' ? messageDisplay(entry.message) : undefined;
  let details = 'details' in raw ? raw.details : undefined;
  if (raw.role === 'bashExecution') {
    details = { command: raw.command, exitCode: raw.exitCode ?? null, cancelled: raw.cancelled, truncated: raw.truncated,
      excludeFromContext: raw.excludeFromContext ?? false, ...(raw.fullOutputPath ? { fullOutputPath: raw.fullOutputPath } : {}) };
    content.splice(0, content.length, { type: 'text', text: raw.output });
  }
  if (display && (details === undefined || details !== null && typeof details === 'object' && !Array.isArray(details))) {
    details = { ...(details as Record<string, unknown> | undefined), [MESSAGE_DISPLAY_KEY]: display };
  }
  return parseSchema(MessageSchema, { id, entryId: entry.id, ...(entry.parentId ? { parentEntryId: entry.parentId } : {}),
    role: raw.role === 'toolResult' ? 'tool' : ['user', 'assistant', 'system', 'custom'].includes(raw.role) ? raw.role : 'custom',
    content, timestamp: Math.max(0, Date.parse(entry.timestamp) || 0),
    ...('customType' in raw ? { customType: raw.customType } : {}),
    ...(raw.role === 'bashExecution' ? { customType: 'bashExecution' } : {}),
    ...(details === undefined ? {} : { details }),
    ...(origin ? { origin } : {}),
  });
}
export function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex'); }
export function boundedText(value: string, bytes: number): string {
  if (Buffer.byteLength(value) <= bytes) return value;
  let result = ''; let size = 0;
  for (const point of value) { size += Buffer.byteLength(point); if (size > bytes) break; result += point; }
  return result;
}
function resultText(value: unknown): string {
  if (!value || typeof value !== 'object' || !('content' in value) || !Array.isArray(value.content)) return '';
  return value.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
}
export function profilePolicy(session: ControlSessionMetadata) {
  return { mode: session.policy.effective, generation: session.policy.generation };
}
