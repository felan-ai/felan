import {
  sessionEntryToContextMessages,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  getLocalToolDisplayMode,
  type LocalToolDisplayMode,
} from '../settings.js';

type AgentMessage = AgentSession['messages'][number];
type AssistantMessage = Extract<AgentMessage, { role: 'assistant' }>;
type ToolResultMessage = Extract<AgentMessage, { role: 'toolResult' }>;

export interface ToolActivityContent {
  readonly type: string;
  readonly text?: string;
  readonly data?: string;
  readonly mimeType?: string;
}

export interface ToolActivityResult {
  readonly content: readonly ToolActivityContent[];
  readonly details?: unknown;
}

export type ToolActivityStatus = 'pending' | 'running' | 'completed' | 'error';

export interface ToolActivityCall {
  readonly id: string;
  name: string;
  args: unknown;
  relatedCommand?: string;
  status: ToolActivityStatus;
  isPartial: boolean;
  isError: boolean;
  startedAt?: number;
  completedAt?: number;
  result?: ToolActivityResult;
}

export interface ToolActivityGroup {
  readonly id: string;
  readonly callIds: readonly string[];
  readonly standalone: boolean;
}

export interface ToolActivityPlacement {
  readonly groupId: string;
  readonly anchor: boolean;
}

interface AssistantSegment {
  readonly kind: 'assistant';
  visible: boolean;
  callIds: string[];
}

interface BoundarySegment {
  readonly kind: 'boundary';
}

type TranscriptSegment = AssistantSegment | BoundarySegment;
type ActivityListener = () => void;
type RendererInvalidator = () => void;

const STANDALONE_TOOLS = new Set([
  'ask_user',
  'view_image',
]);
const RUNNING_SESSION_PATTERN = /^Process running with session ID (\d+)\s*$/mu;
const ABORTED_SESSION_PATTERN = /\bexec_command aborted; process continues as session (\d+)\b/iu;

export class ToolActivityState {
  readonly #calls = new Map<string, ToolActivityCall>();
  readonly #execCommands = new Map<string, string>();
  readonly #sessionCommands = new Map<string, string>();
  readonly #relatedCommands = new Map<string, string>();
  readonly #definitions = new Map<string, ToolDefinition<any, any, any>>();
  readonly #listeners = new Set<ActivityListener>();
  readonly #rendererInvalidators = new Map<string, RendererInvalidator>();
  #segments: TranscriptSegment[] = [];
  #groups: ToolActivityGroup[] = [];
  #groupsById = new Map<string, ToolActivityGroup>();
  #placements = new Map<string, ToolActivityPlacement>();
  #activeAssistant: AssistantSegment | undefined;
  #session: AgentSession | undefined;
  #unsubscribe: (() => void) | undefined;

  constructor(private displayMode: LocalToolDisplayMode) {}

  get mode(): LocalToolDisplayMode {
    return this.displayMode;
  }

  get cwd(): string {
    return this.#session?.sessionManager.getCwd() ?? process.cwd();
  }

  setMode(mode: LocalToolDisplayMode): void {
    if (mode === this.displayMode) return;
    this.displayMode = mode;
    this.#invalidateAllRenderers();
    this.#emit();
  }

  refreshMode(): void {
    if (this.#session) this.setMode(getLocalToolDisplayMode(this.#session.settingsManager));
  }

  attach(session: AgentSession): void {
    this.#unsubscribe?.();
    this.#session = session;
    this.rebuild();
    this.#unsubscribe = session.subscribe((event) => this.#handleEvent(event));
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#session = undefined;
    this.#activeAssistant = undefined;
    this.#calls.clear();
    this.#execCommands.clear();
    this.#sessionCommands.clear();
    this.#relatedCommands.clear();
    this.#definitions.clear();
    this.#segments = [];
    this.#groups = [];
    this.#groupsById.clear();
    this.#placements.clear();
    this.#rendererInvalidators.clear();
    this.#listeners.clear();
  }

  rebuild(): void {
    const session = this.#session;
    if (!session) return;

    this.#calls.clear();
    this.#rebuildCommandLinks(session);
    this.#segments = [];
    this.#activeAssistant = undefined;

    for (const entry of session.sessionManager.buildContextEntries()) {
      const messages = sessionEntryToContextMessages(entry);
      if (messages.length === 0) {
        if (entry.type === 'custom') this.#appendBoundary();
        continue;
      }
      for (const message of messages) this.#replayMessage(message);
    }

    const streamingMessage = session.state.streamingMessage;
    if (streamingMessage?.role === 'assistant') {
      this.#activeAssistant = this.#appendAssistant(streamingMessage);
    }
    for (const toolCallId of session.state.pendingToolCalls) {
      const call = this.#calls.get(toolCallId);
      if (call && call.status === 'pending') call.status = 'running';
    }

    this.#rebuildGroups();
  }

  subscribe(listener: ActivityListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  calls(): readonly ToolActivityCall[] {
    const ordered: ToolActivityCall[] = [];
    const seen = new Set<string>();
    for (const segment of this.#segments) {
      if (segment.kind !== 'assistant') continue;
      for (const id of segment.callIds) {
        if (seen.has(id)) continue;
        const call = this.#calls.get(id);
        if (!call) continue;
        seen.add(id);
        ordered.push(call);
      }
    }
    for (const [id, call] of this.#calls) {
      if (!seen.has(id)) ordered.push(call);
    }
    return ordered;
  }

  groups(): readonly ToolActivityGroup[] {
    return this.#groups;
  }

  group(groupId: string): ToolActivityGroup | undefined {
    return this.#groupsById.get(groupId);
  }

  call(toolCallId: string): ToolActivityCall | undefined {
    return this.#calls.get(toolCallId);
  }

  placement(toolCallId: string): ToolActivityPlacement | undefined {
    return this.#placements.get(toolCallId);
  }

  rememberDefinition(toolName: string, definition: ToolDefinition<any, any, any> | undefined): void {
    if (definition) this.#definitions.set(toolName, definition);
  }

  definition(toolName: string): ToolDefinition<any, any, any> | undefined {
    return this.#definitions.get(toolName);
  }

  registerRenderer(toolCallId: string, invalidate: RendererInvalidator): void {
    this.#rendererInvalidators.set(toolCallId, invalidate);
  }

  observeRendererCall(toolCallId: string, toolName: string, args: unknown): void {
    let call = this.#calls.get(toolCallId);
    if (!call) {
      call = this.#ensureCall(toolCallId, toolName, args, Date.now());
      this.#linkCommand(call);
      const segment = this.#activeAssistant ?? this.#appendSyntheticAssistant();
      segment.callIds.push(toolCallId);
      this.#rebuildGroups();
      return;
    }
    call.name = toolName;
    call.args = args;
    this.#linkCommand(call);
  }

  isRendererPreserved(toolName: string): boolean {
    return toolName === 'ask_user';
  }

  #handleEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case 'message_start':
        if (event.message.role === 'assistant') {
          this.#activeAssistant = this.#appendAssistant(event.message);
          this.#rebuildGroups();
        } else if (event.message.role !== 'toolResult') {
          this.#activeAssistant = undefined;
          this.#appendBoundary();
          this.#rebuildGroups();
        }
        break;
      case 'message_update':
        if (event.message.role === 'assistant') this.#updateAssistant(event.message);
        break;
      case 'message_end':
        if (event.message.role === 'assistant') {
          this.#updateAssistant(event.message);
          this.#markAssistantFailure(event.message);
          this.#activeAssistant = undefined;
        } else if (event.message.role === 'toolResult') {
          this.#applyToolResult(event.message);
        }
        break;
      case 'tool_execution_start': {
        const call = this.#ensureLiveCall(event.toolCallId, event.toolName, event.args);
        call.status = 'running';
        call.startedAt ??= Date.now();
        call.isPartial = true;
        this.#invalidateCall(call.id);
        break;
      }
      case 'tool_execution_update': {
        const call = this.#ensureLiveCall(event.toolCallId, event.toolName, event.args);
        call.status = 'running';
        call.startedAt ??= Date.now();
        call.isPartial = true;
        call.isError = false;
        call.result = normalizeResult(event.partialResult);
        this.#rememberSessionCommand(call);
        this.#invalidateCall(call.id);
        break;
      }
      case 'tool_execution_end': {
        const call = this.#ensureLiveCall(event.toolCallId, event.toolName, undefined);
        call.status = event.isError ? 'error' : 'completed';
        call.isPartial = false;
        call.isError = event.isError;
        call.completedAt = Date.now();
        call.result = normalizeResult(event.result);
        this.#rememberSessionCommand(call);
        this.#rebuildGroups();
        this.#invalidateCall(call.id);
        break;
      }
      case 'entry_appended':
        if (event.entry.type === 'custom') {
          this.#appendBoundary();
          this.#rebuildGroups();
        }
        break;
      case 'compaction_end':
        if (!event.aborted && event.result) this.rebuild();
        break;
      case 'agent_end':
      case 'auto_retry_start':
        this.#activeAssistant = undefined;
        this.#appendBoundary();
        this.#rebuildGroups();
        break;
      default:
        break;
    }
  }

  #replayMessage(message: AgentMessage): void {
    if (message.role === 'assistant') {
      this.#appendAssistant(message);
      this.#markAssistantFailure(message);
    } else if (message.role === 'toolResult') {
      this.#applyToolResult(message);
    } else {
      this.#appendBoundary();
    }
  }

  #appendAssistant(message: AssistantMessage): AssistantSegment {
    const segment: AssistantSegment = {
      kind: 'assistant',
      visible: hasVisibleAssistantContent(message),
      callIds: [],
    };
    this.#segments.push(segment);
    for (const content of message.content) {
      if (content.type !== 'toolCall') continue;
      segment.callIds.push(content.id);
      const call = this.#ensureCall(
        content.id,
        content.name,
        content.arguments,
        message.timestamp,
      );
      call.name = content.name;
      call.args = content.arguments;
      this.#linkCommand(call);
    }
    return segment;
  }

  #appendSyntheticAssistant(): AssistantSegment {
    const segment: AssistantSegment = { kind: 'assistant', visible: false, callIds: [] };
    this.#segments.push(segment);
    this.#activeAssistant = segment;
    return segment;
  }

  #updateAssistant(message: AssistantMessage): void {
    const segment = this.#activeAssistant ?? this.#appendAssistant(message);
    const nextIds: string[] = [];
    let structureChanged = segment.visible !== hasVisibleAssistantContent(message);
    segment.visible = hasVisibleAssistantContent(message);
    for (const content of message.content) {
      if (content.type !== 'toolCall') continue;
      nextIds.push(content.id);
      const call = this.#ensureCall(content.id, content.name, content.arguments, message.timestamp);
      call.name = content.name;
      call.args = content.arguments;
      this.#linkCommand(call);
      this.#invalidateCall(call.id);
    }
    if (!sameIds(segment.callIds, nextIds)) {
      segment.callIds = nextIds;
      structureChanged = true;
    }
    if (structureChanged) this.#rebuildGroups();
  }

  #markAssistantFailure(message: AssistantMessage): void {
    if (message.stopReason !== 'error' && message.stopReason !== 'aborted') return;
    const error = message.stopReason === 'aborted'
      ? message.errorMessage || 'Operation aborted'
      : message.errorMessage || 'Error';
    for (const content of message.content) {
      if (content.type !== 'toolCall') continue;
      const call = this.#calls.get(content.id);
      if (!call || call.result) continue;
      call.status = 'error';
      call.isError = true;
      call.isPartial = false;
      call.completedAt = toTimestamp(message.timestamp) ?? Date.now();
      call.result = { content: [{ type: 'text', text: error }] };
      this.#invalidateCall(call.id);
    }
  }

  #applyToolResult(message: ToolResultMessage): void {
    const existing = this.#calls.get(message.toolCallId);
    const call = this.#ensureCall(
      message.toolCallId,
      message.toolName,
      existing?.args,
      existing?.startedAt ?? message.timestamp,
    );
    call.name = message.toolName;
    call.status = message.isError ? 'error' : 'completed';
    call.isError = message.isError;
    call.isPartial = false;
    call.completedAt = toTimestamp(message.timestamp) ?? Date.now();
    call.result = normalizeResult(message);
    this.#rememberSessionCommand(call);
    this.#invalidateCall(call.id);
  }

  #ensureLiveCall(toolCallId: string, toolName: string, args: unknown): ToolActivityCall {
    const call = this.#ensureCall(toolCallId, toolName, args, Date.now());
    if (!this.#placements.has(toolCallId)) {
      const segment = this.#activeAssistant ?? this.#appendSyntheticAssistant();
      if (!segment.callIds.includes(toolCallId)) segment.callIds.push(toolCallId);
      this.#rebuildGroups();
    }
    if (args !== undefined) call.args = args;
    call.name = toolName;
    this.#linkCommand(call);
    return call;
  }

  #rebuildCommandLinks(session: AgentSession): void {
    this.#execCommands.clear();
    this.#sessionCommands.clear();
    this.#relatedCommands.clear();

    for (const entry of session.sessionManager.getBranch()) {
      for (const message of sessionEntryToContextMessages(entry)) {
        if (message.role === 'assistant') {
          for (const content of message.content) {
            if (content.type !== 'toolCall') continue;
            if (isExecCommand(content.name)) {
              const command = commandFromArgs(content.arguments);
              if (command) this.#execCommands.set(content.id, command);
              continue;
            }
            if (!isWriteStdin(content.name)) continue;
            const sessionId = sessionKeyFromArgs(content.arguments);
            const command = sessionId ? this.#sessionCommands.get(sessionId) : undefined;
            if (command) this.#relatedCommands.set(content.id, command);
          }
          continue;
        }
        if (message.role !== 'toolResult' || !isExecCommand(message.toolName)) continue;
        const command = this.#execCommands.get(message.toolCallId);
        const sessionId = sessionKeyFromResult(message);
        if (command && sessionId) this.#sessionCommands.set(sessionId, command);
      }
    }
  }

  #linkCommand(call: ToolActivityCall): void {
    if (isExecCommand(call.name)) {
      const command = commandFromArgs(call.args);
      if (command) this.#execCommands.set(call.id, command);
      this.#rememberSessionCommand(call);
      return;
    }
    if (!isWriteStdin(call.name)) return;

    const sessionId = sessionKeyFromArgs(call.args);
    const command = this.#relatedCommands.get(call.id)
      ?? (sessionId ? this.#sessionCommands.get(sessionId) : undefined);
    if (!command) {
      delete call.relatedCommand;
      return;
    }
    call.relatedCommand = command;
    this.#relatedCommands.set(call.id, command);
  }

  #rememberSessionCommand(call: ToolActivityCall): void {
    if (!isExecCommand(call.name) || !call.result) return;
    const command = commandFromArgs(call.args) ?? this.#execCommands.get(call.id);
    const sessionId = sessionKeyFromResult(call.result);
    if (command && sessionId) this.#sessionCommands.set(sessionId, command);
  }

  #ensureCall(
    id: string,
    name: string,
    args: unknown,
    startedAt: string | number | undefined,
    existing: ToolActivityCall | undefined = this.#calls.get(id),
  ): ToolActivityCall {
    if (existing) {
      this.#calls.set(id, existing);
      return existing;
    }
    const normalizedStartedAt = toTimestamp(startedAt);
    const call: ToolActivityCall = {
      id,
      name,
      args,
      status: 'pending',
      isPartial: true,
      isError: false,
      ...(normalizedStartedAt === undefined ? {} : { startedAt: normalizedStartedAt }),
    };
    this.#calls.set(id, call);
    return call;
  }

  #appendBoundary(): void {
    if (this.#segments.at(-1)?.kind === 'boundary') return;
    this.#segments.push({ kind: 'boundary' });
  }

  #rebuildGroups(): void {
    const previousGroups = this.#groups;
    const nextGroups: ToolActivityGroup[] = [];
    let pending: string[] = [];
    const flush = (standalone = false) => {
      if (pending.length === 0) return;
      nextGroups.push({ id: pending[0]!, callIds: pending, standalone });
      pending = [];
    };

    for (const segment of this.#segments) {
      if (segment.kind === 'boundary') {
        flush();
        continue;
      }
      if (segment.visible) flush();
      for (const callId of segment.callIds) {
        const call = this.#calls.get(callId);
        if (!call) continue;
        if (isStandalone(call)) {
          flush();
          pending.push(callId);
          flush(true);
        } else if (!pending.includes(callId)) {
          pending.push(callId);
        }
      }
    }
    flush();

    this.#groups = nextGroups;
    this.#groupsById = new Map(nextGroups.map((group) => [group.id, group]));
    this.#placements = new Map();
    for (const group of nextGroups) {
      group.callIds.forEach((callId, index) => {
        this.#placements.set(callId, { groupId: group.id, anchor: index === 0 });
      });
    }

    const changedAnchors = changedGroupAnchors(previousGroups, nextGroups);
    for (const callId of changedAnchors) this.#rendererInvalidators.get(callId)?.();
    this.#emit();
  }

  #invalidateCall(toolCallId: string): void {
    const placement = this.#placements.get(toolCallId);
    if (placement) this.#rendererInvalidators.get(placement.groupId)?.();
    else this.#rendererInvalidators.get(toolCallId)?.();
    this.#emit();
  }

  #invalidateAllRenderers(): void {
    for (const invalidate of new Set(this.#rendererInvalidators.values())) invalidate();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

function hasVisibleAssistantContent(message: AssistantMessage): boolean {
  return message.content.some((content) => (
    (content.type === 'text' && content.text.trim().length > 0)
    || (content.type === 'thinking' && content.thinking.trim().length > 0)
  ));
}

function normalizeResult(result: {
  content?: readonly ToolActivityContent[];
  details?: unknown;
}): ToolActivityResult {
  return {
    content: Array.isArray(result.content) ? result.content : [],
    ...(result.details === undefined ? {} : { details: result.details }),
  };
}

function isExecCommand(toolName: string): boolean {
  return toolName.toLowerCase().includes('exec_command');
}

function isWriteStdin(toolName: string): boolean {
  return toolName.toLowerCase().includes('write_stdin');
}

function commandFromArgs(args: unknown): string | undefined {
  const record = toRecord(args);
  for (const key of ['cmd', 'command'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function sessionKeyFromArgs(args: unknown): string | undefined {
  return sessionKey(toRecord(args).session_id);
}

function sessionKeyFromResult(result: {
  readonly details?: unknown;
  readonly content?: readonly ToolActivityContent[];
}): string | undefined {
  const structured = sessionKey(toRecord(result.details).session_id);
  if (structured) return structured;
  for (const content of result.content ?? []) {
    if (content.type !== 'text' || !content.text) continue;
    const outputMarker = content.text.indexOf('\nOutput:\n');
    const metadata = outputMarker === -1 ? content.text : content.text.slice(0, outputMarker);
    const match = RUNNING_SESSION_PATTERN.exec(metadata) ?? ABORTED_SESSION_PATTERN.exec(metadata);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function sessionKey(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^\d+$/u.test(value.trim())) return value.trim();
  return undefined;
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isStandalone(call: ToolActivityCall): boolean {
  return STANDALONE_TOOLS.has(call.name)
    || call.result?.content.some((content) => content.type === 'image') === true;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function changedGroupAnchors(
  previous: readonly ToolActivityGroup[],
  next: readonly ToolActivityGroup[],
): Set<string> {
  const signatures = new Map(previous.map((group) => [group.id, group.callIds.join('\0')]));
  const changed = new Set<string>();
  for (const group of next) {
    if (signatures.get(group.id) !== group.callIds.join('\0')) changed.add(group.id);
    signatures.delete(group.id);
  }
  for (const groupId of signatures.keys()) changed.add(groupId);
  return changed;
}

function toTimestamp(value: string | number | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}
