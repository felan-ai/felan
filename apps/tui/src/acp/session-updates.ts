import {
  RequestError,
  methods,
  type AgentContext,
  type ContentBlock,
  type SessionUpdate,
  type ToolCallContent,
  type ToolCallLocation,
  type ToolKind,
} from '@agentclientprotocol/sdk';
import {
  sessionEntryToContextMessages,
  type AgentSessionEvent,
  type SessionEntry,
} from '@felan-ai/agent-core';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const MAX_PROMPT_BLOCKS = 128;
const MAX_PROMPT_SERIALIZED_BYTES = 512 * 1024;
const MAX_PROMPT_BLOCK_BYTES = 64 * 1024;
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_RESOURCE_FIELD_BYTES = 16 * 1024;
const MAX_ASSISTANT_TURN_BYTES = 1024 * 1024;
const MAX_TURN_UPDATES = 10_000;
const MAX_TURN_TOOL_CALLS = 1_024;
const MAX_SESSION_TOOL_CALL_IDS = 100_000;
const MAX_MESSAGE_CONTENT_PARTS = 2_048;
const MAX_UPDATE_TEXT_BYTES = 64 * 1024;
const MAX_REPLAY_TEXT_BYTES = 256 * 1024;
const MAX_REPLAY_ENTRIES = 100_000;
const MAX_REPLAY_UPDATES = 100_000;
const MAX_REPLAY_BYTES = 64 * 1024 * 1024;
const MAX_REPLAY_TOOL_CALLS = 10_000;
const MAX_RAW_VALUE_BYTES = 64 * 1024;
const MAX_RAW_STRING_BYTES = 20 * 1024;
const MAX_RAW_DEPTH = 8;
const MAX_RAW_ENTRIES = 100;
const MAX_TOOL_CONTENT_ITEMS = 32;
const MAX_TOOL_CONTENT_BYTES = 128 * 1024;
const MAX_TOOL_TITLE_BYTES = 512;
const MAX_TOOL_ID_BYTES = 512;
const MAX_MESSAGE_ID_BYTES = 512;
const MAX_LOCATION_BYTES = 4 * 1024;
const MAX_LOCATIONS = 8;
const MAX_DIFF_FILE_BYTES = 256 * 1024;
const MAX_ERROR_BYTES = 4 * 1024;
const MAX_ERROR_SCAN_BYTES = 64 * 1024;
const TRUNCATION_MARKER = '\n… [truncated]';
const SENSITIVE_KEYS = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'clientsecret',
  'cookie',
  'password',
  'privatekey',
  'refreshtoken',
  'secret',
  'token',
]);

type SupportedPromptBlock = Extract<ContentBlock, { type: 'text' | 'resource_link' }>;

export interface PreparedAcpPrompt {
  readonly text: string;
  readonly blocks: readonly SupportedPromptBlock[];
}

interface AcpPromptUpdateStreamOptions {
  readonly sessionId: string;
  readonly cwd: string;
  readonly turn: number;
  readonly client: AgentContext;
  readonly isActive: () => boolean;
  readonly toolCallIds?: AcpToolCallIdRegistry;
}

interface ToolState {
  readonly wireId: string;
  name: string;
  args: unknown;
  status: 'pending' | 'in_progress' | 'terminal';
  snapshotPath?: string;
  beforeSnapshot?: FileSnapshot;
}

interface FileSnapshot {
  readonly path: string;
  readonly text: string | null;
}

interface ToolOutput {
  readonly content: ToolCallContent[];
  readonly rawOutput?: unknown;
}

export function prepareAcpPrompt(content: readonly ContentBlock[]): PreparedAcpPrompt {
  let serializedBytes: number;
  try {
    serializedBytes = Buffer.byteLength(JSON.stringify(content));
  } catch {
    throw RequestError.invalidParams(undefined, 'Prompt content must be serializable');
  }
  if (serializedBytes > MAX_PROMPT_SERIALIZED_BYTES) {
    throw RequestError.invalidParams(
      { maxBytes: MAX_PROMPT_SERIALIZED_BYTES },
      'Prompt payload exceeds the maximum encoded size',
    );
  }
  if (content.length > MAX_PROMPT_BLOCKS) {
    throw RequestError.invalidParams(
      { maxBlocks: MAX_PROMPT_BLOCKS },
      'Prompt contains too many content blocks',
    );
  }

  const blocks: SupportedPromptBlock[] = [];
  const modelParts: string[] = [];
  let totalBytes = 0;
  for (const part of content) {
    if (part.type === 'text') {
      assertBoundedText(part.text, MAX_PROMPT_BLOCK_BYTES, 'Prompt text block');
      assertNoNul(part.text, 'Prompt text block');
      blocks.push({ type: 'text', text: part.text });
      modelParts.push(part.text);
      totalBytes += Buffer.byteLength(part.text);
    } else if (part.type === 'resource_link') {
      const name = boundedResourceField(part.name, 'Resource name');
      const uri = boundedResourceField(part.uri, 'Resource URI');
      const description = part.description === undefined || part.description === null
        ? undefined
        : boundedResourceField(part.description, 'Resource description');
      const title = part.title === undefined || part.title === null
        ? undefined
        : boundedResourceField(part.title, 'Resource title');
      const mimeType = part.mimeType === undefined || part.mimeType === null
        ? undefined
        : boundedResourceField(part.mimeType, 'Resource MIME type');
      const safe: SupportedPromptBlock = {
        type: 'resource_link',
        name,
        uri,
        ...(description === undefined ? {} : { description }),
        ...(title === undefined ? {} : { title }),
        ...(mimeType === undefined ? {} : { mimeType }),
        ...(typeof part.size === 'number' && Number.isSafeInteger(part.size) && part.size >= 0
          ? { size: part.size }
          : {}),
      };
      blocks.push(safe);
      const modelText = formatResourceLink(safe);
      modelParts.push(modelText);
      totalBytes += Buffer.byteLength(modelText);
    } else {
      throw RequestError.invalidParams(
        { contentType: part.type },
        `Unsupported prompt content type: ${part.type}`,
      );
    }
    if (totalBytes > MAX_PROMPT_BYTES) {
      throw RequestError.invalidParams(
        { maxBytes: MAX_PROMPT_BYTES },
        'Prompt exceeds the maximum encoded size',
      );
    }
  }

  const text = modelParts.join('\n').trim();
  if (!text) throw RequestError.invalidParams(undefined, 'Prompt must contain text or a resource link');
  if (Buffer.byteLength(text) > MAX_PROMPT_BYTES) {
    throw RequestError.invalidParams(
      { maxBytes: MAX_PROMPT_BYTES },
      'Prompt exceeds the maximum encoded size',
    );
  }
  return { text, blocks };
}

export class AcpToolCallIdRegistry {
  readonly #used = new Set<string>();
  readonly #latest = new Map<string, string>();

  claim(id: string, scope = ''): string {
    if (this.#used.size >= MAX_SESSION_TOOL_CALL_IDS) {
      throw RequestError.internalError(
        { maxToolCalls: MAX_SESSION_TOOL_CALL_IDS },
        'Session contains too many tool calls',
      );
    }
    const preferred = wireToolCallId(id);
    if (!this.#used.has(preferred)) {
      this.#used.add(preferred);
      this.#latest.set(toolCallScopeKey(scope, id), preferred);
      return preferred;
    }
    let sequence = 1;
    while (true) {
      const candidate = `tool-${createHash('sha256')
        .update(`${id}\0${sequence}`)
        .digest('hex')
        .slice(0, 32)}`;
      if (!this.#used.has(candidate)) {
        this.#used.add(candidate);
        this.#latest.set(toolCallScopeKey(scope, id), candidate);
        return candidate;
      }
      sequence += 1;
    }
  }

  current(id: string, scope = ''): string | undefined {
    return this.#latest.get(toolCallScopeKey(scope, id));
  }
}

function toolCallScopeKey(scope: string, id: string): string {
  return `${scope}\0${id}`;
}

export interface AcpToolCallDetails {
  readonly toolCallId: string;
  readonly title: string;
  readonly kind: ToolKind;
  readonly locations?: ToolCallLocation[];
  readonly rawInput: unknown;
}

export function createAcpToolCallUpdate(
  cwd: string,
  toolCallId: string,
  name: string,
  args: unknown,
): AcpToolCallDetails {
  const safeName = truncateUtf8(name, MAX_TOOL_TITLE_BYTES * 2);
  const metadata = toolMetadata(cwd, safeName, args);
  return {
    toolCallId,
    title: metadata.title,
    kind: metadata.kind,
    ...(metadata.locations.length === 0 ? {} : { locations: metadata.locations }),
    rawInput: boundToolInput(cwd, name, args),
  };
}

export class AcpPromptUpdateStream {
  readonly #sessionId: string;
  readonly #cwd: string;
  readonly #client: AgentContext;
  readonly #isActive: () => boolean;
  readonly #turnPrefix: string;
  readonly #tools = new Map<string, ToolState>();
  readonly #toolCallIds: AcpToolCallIdRegistry;
  #tail = Promise.resolve();
  #failure: unknown;
  #messageSequence = 0;
  #assistantMessageId: string | undefined;
  #assistantStreamedIndexes = new Set<string>();
  #remainingAssistantBytes = MAX_ASSISTANT_TURN_BYTES;
  #expectPromptUser = true;
  #queuedUpdates = 0;

  constructor(options: AcpPromptUpdateStreamOptions) {
    this.#sessionId = options.sessionId;
    this.#cwd = options.cwd;
    this.#client = options.client;
    this.#isActive = options.isActive;
    this.#turnPrefix = wireMessageId(`${options.sessionId}:turn:${options.turn}`);
    this.#toolCallIds = options.toolCallIds ?? new AcpToolCallIdRegistry();
  }

  emitPrompt(blocks: readonly SupportedPromptBlock[]): void {
    const messageId = wireMessageId(`${this.#turnPrefix}:user:0`);
    for (const content of blocks) {
      this.#enqueue({ sessionUpdate: 'user_message_chunk', content, messageId });
    }
  }

  handle(event: AgentSessionEvent): void {
    try {
      switch (event.type) {
        case 'message_start':
          if (event.message.role === 'assistant') this.#startAssistantMessage();
          else if (event.message.role === 'user') this.#handleUserMessage(event.message.content);
          break;
        case 'message_update':
          if (event.message.role === 'assistant') {
            this.#handleAssistantUpdate(event.message, event.assistantMessageEvent);
          }
          break;
        case 'message_end':
          if (event.message.role === 'assistant') this.#finishAssistantMessage(event.message);
          else if (event.message.role === 'toolResult') {
            this.#finishTool(
              event.message.toolCallId,
              event.message.toolName,
              event.message,
              event.message.isError,
            );
          }
          break;
        case 'tool_execution_start':
          this.#startTool(event.toolCallId, event.toolName, event.args);
          break;
        case 'tool_execution_update':
          this.#updateTool(event.toolCallId, event.toolName, event.args, event.partialResult);
          break;
        case 'tool_execution_end':
          this.#finishTool(event.toolCallId, event.toolName, event.result, event.isError);
          break;
        default:
          break;
      }
    } catch (error) {
      this.#failure ??= error;
    }
  }

  finish(cancelled: boolean): void {
    const message = cancelled ? 'Operation cancelled' : 'Tool did not complete';
    for (const state of this.#tools.values()) {
      if (state.status === 'terminal') continue;
      state.status = 'terminal';
      this.#enqueue({
        sessionUpdate: 'tool_call_update',
        toolCallId: state.wireId,
        status: 'failed',
        content: textToolContent(message),
      });
    }
  }

  async flush(): Promise<void> {
    await this.#tail;
    if (this.#failure !== undefined) throw this.#failure;
  }

  #handleUserMessage(content: string | readonly { type: string; text?: string }[]): void {
    if (this.#expectPromptUser) {
      this.#expectPromptUser = false;
      return;
    }
    const messageId = this.#nextMessageId('user');
    const parts = typeof content === 'string' ? [content] : content
      .filter((part): part is { type: 'text'; text: string } => (
        part.type === 'text' && typeof part.text === 'string'
      ))
      .map(({ text }) => text);
    for (const text of parts) {
      this.#enqueue({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: truncateUtf8(text, MAX_UPDATE_TEXT_BYTES) },
        messageId,
      });
    }
  }

  #startAssistantMessage(): void {
    this.#assistantMessageId = this.#nextMessageId('assistant');
    this.#assistantStreamedIndexes = new Set();
  }

  #handleAssistantUpdate(
    message: Extract<AgentSessionEvent, { type: 'message_update' }>['message'],
    update: Extract<AgentSessionEvent, { type: 'message_update' }>['assistantMessageEvent'],
  ): void {
    const messageId = this.#assistantMessageId ?? this.#nextMessageId('assistant');
    this.#assistantMessageId = messageId;
    if (update.type === 'text_delta' || update.type === 'thinking_delta') {
      const kind = update.type === 'text_delta' ? 'text' : 'thinking';
      if (kind === 'thinking' && isRedactedThinking(message, update.contentIndex)) return;
      this.#assistantStreamedIndexes.add(`${kind}:${update.contentIndex}`);
      this.#emitAssistantChunk(kind, update.delta, messageId);
      return;
    }
    if (update.type === 'text_end' || update.type === 'thinking_end') {
      const kind = update.type === 'text_end' ? 'text' : 'thinking';
      if (kind === 'thinking' && isRedactedThinking(message, update.contentIndex)) return;
      const key = `${kind}:${update.contentIndex}`;
      if (!this.#assistantStreamedIndexes.has(key)) {
        this.#assistantStreamedIndexes.add(key);
        this.#emitAssistantChunk(kind, update.content, messageId);
      }
      return;
    }
    if (update.type === 'toolcall_end') {
      this.#ensureTool(update.toolCall.id, update.toolCall.name, update.toolCall.arguments, true);
    }
  }

  #finishAssistantMessage(
    message: Extract<AgentSessionEvent, { type: 'message_end' }>['message'] & { role: 'assistant' },
  ): void {
    const messageId = this.#assistantMessageId ?? this.#nextMessageId('assistant');
    for (let index = 0; index < message.content.length; index += 1) {
      const part = message.content[index]!;
      if (part.type === 'text') {
        if (!this.#assistantStreamedIndexes.has(`text:${index}`)) {
          this.#emitAssistantChunk('text', part.text, messageId);
        }
      } else if (part.type === 'thinking') {
        if (!part.redacted && !this.#assistantStreamedIndexes.has(`thinking:${index}`)) {
          this.#emitAssistantChunk('thinking', part.thinking, messageId);
        }
      } else {
        this.#ensureTool(part.id, part.name, part.arguments, true);
      }
    }
    if (message.stopReason === 'aborted' || message.stopReason === 'error') {
      const failure = message.stopReason === 'aborted'
        ? 'Operation cancelled'
        : sanitizeAcpErrorMessage(message.errorMessage ?? 'Tool execution failed');
      for (const state of this.#tools.values()) {
        if (state.status === 'terminal') continue;
        state.status = 'terminal';
        this.#enqueue({
          sessionUpdate: 'tool_call_update',
          toolCallId: state.wireId,
          status: 'failed',
          content: textToolContent(failure),
        });
      }
    }
    this.#assistantMessageId = undefined;
    this.#assistantStreamedIndexes.clear();
  }

  #emitAssistantChunk(kind: 'text' | 'thinking', text: string, messageId: string): void {
    if (!text || this.#remainingAssistantBytes <= 0) return;
    const limit = Math.min(MAX_UPDATE_TEXT_BYTES, this.#remainingAssistantBytes);
    const truncated = Buffer.byteLength(text) > limit;
    const bounded = truncateUtf8(text, limit);
    this.#remainingAssistantBytes = truncated
      ? 0
      : this.#remainingAssistantBytes - Buffer.byteLength(bounded);
    if (!bounded) return;
    this.#enqueue({
      sessionUpdate: kind === 'text' ? 'agent_message_chunk' : 'agent_thought_chunk',
      content: { type: 'text', text: bounded },
      messageId,
    });
  }

  #ensureTool(
    toolCallId: string,
    name: string,
    args: unknown,
    newOccurrence = false,
  ): ToolState {
    const existing = this.#tools.get(toolCallId);
    if (existing && (!newOccurrence || existing.status !== 'terminal')) return existing;
    if (this.#tools.size >= MAX_TURN_TOOL_CALLS) {
      throw RequestError.internalError(
        { maxToolCalls: MAX_TURN_TOOL_CALLS },
        'Model produced too many tool calls in one turn',
      );
    }
    const safeName = truncateUtf8(name, MAX_TOOL_TITLE_BYTES * 2);
    const state: ToolState = {
      wireId: this.#toolCallIds.claim(toolCallId),
      name: safeName,
      args,
      status: 'pending',
    };
    this.#tools.set(toolCallId, state);
    const update = createAcpToolCallUpdate(this.#cwd, state.wireId, safeName, args);
    this.#enqueue({
      sessionUpdate: 'tool_call',
      status: 'pending',
      ...update,
    });
    return state;
  }

  #startTool(toolCallId: string, name: string, args: unknown, newOccurrence = true): ToolState {
    const state = this.#ensureTool(toolCallId, name, args, newOccurrence);
    if (state.status !== 'pending') return state;
    state.name = truncateUtf8(name, MAX_TOOL_TITLE_BYTES * 2);
    if (args !== undefined) state.args = args;
    state.status = 'in_progress';
    const snapshotPath = mutationFilePath(this.#cwd, name, args);
    if (snapshotPath !== undefined) {
      state.snapshotPath = snapshotPath;
      const beforeSnapshot = snapshotTextFile(this.#cwd, snapshotPath);
      if (beforeSnapshot !== undefined) state.beforeSnapshot = beforeSnapshot;
    }
    const update = createAcpToolCallUpdate(
      this.#cwd,
      state.wireId,
      state.name,
      state.args,
    );
    this.#enqueue({
      sessionUpdate: 'tool_call_update',
      status: 'in_progress',
      ...update,
    });
    return state;
  }

  #updateTool(toolCallId: string, name: string, args: unknown, result: unknown): void {
    const state = this.#startTool(toolCallId, name, args);
    if (state.status === 'terminal') return;
    const output = toolOutput(result, false, toolHasSensitivePath(this.#cwd, state.name, state.args));
    this.#enqueue({
      sessionUpdate: 'tool_call_update',
      toolCallId: state.wireId,
      status: 'in_progress',
      ...(output.content.length === 0 ? {} : { content: output.content }),
      ...(output.rawOutput === undefined ? {} : { rawOutput: output.rawOutput }),
    });
  }

  #finishTool(toolCallId: string, name: string, result: unknown, isError: boolean): void {
    const state = this.#startTool(toolCallId, name, undefined, false);
    if (state.status === 'terminal') return;
    state.status = 'terminal';
    const output = toolOutput(
      result,
      isError,
      toolHasSensitivePath(this.#cwd, state.name, state.args),
    );
    const afterSnapshot = state.snapshotPath === undefined
      ? undefined
      : snapshotTextFile(this.#cwd, state.snapshotPath);
    const content = [...output.content];
    const diff = fileDiff(state.beforeSnapshot, afterSnapshot);
    if (diff !== undefined) content.push(diff);
    this.#enqueue({
      sessionUpdate: 'tool_call_update',
      toolCallId: state.wireId,
      status: isError ? 'failed' : 'completed',
      ...(content.length === 0 ? {} : { content }),
      ...(output.rawOutput === undefined ? {} : { rawOutput: output.rawOutput }),
    });
  }

  #nextMessageId(role: 'user' | 'assistant'): string {
    this.#messageSequence += 1;
    return wireMessageId(`${this.#turnPrefix}:${role}:${this.#messageSequence}`);
  }

  #enqueue(update: SessionUpdate | (() => SessionUpdate | undefined | Promise<SessionUpdate | undefined>)): void {
    if (this.#queuedUpdates >= MAX_TURN_UPDATES) {
      this.#failure ??= RequestError.internalError(
        { maxUpdates: MAX_TURN_UPDATES },
        'Model produced too many updates in one turn',
      );
      return;
    }
    this.#queuedUpdates += 1;
    const factory = typeof update === 'function' ? update : () => update;
    this.#tail = this.#tail
      .then(async () => {
        if (this.#failure !== undefined || !this.#isActive()) return;
        const next = await factory();
        if (next === undefined || !this.#isActive()) return;
        await this.#client.notify(methods.client.session.update, {
          sessionId: this.#sessionId,
          update: next,
        });
      })
      .catch((error: unknown) => {
        this.#failure ??= error;
      });
  }
}

export async function replayAcpSessionEntries(
  sessionId: string,
  cwd: string,
  entries: readonly SessionEntry[],
  client: AgentContext,
  isActive: () => boolean = () => true,
  toolCallIds: AcpToolCallIdRegistry = new AcpToolCallIdRegistry(),
): Promise<void> {
  const tools = new Map<string, { readonly wireId: string; name: string; args: unknown; terminal: boolean }>();
  const usedMessageIds = new Set<string>();
  const budget = { entries: 0, updates: 0, bytes: 0 };
  for (const entry of entries) {
    budget.entries += 1;
    if (budget.entries > MAX_REPLAY_ENTRIES) {
      throw RequestError.internalError(
        { maxEntries: MAX_REPLAY_ENTRIES },
        'Persisted session history exceeds the replay entry limit',
      );
    }
    const messages = sessionEntryToContextMessages(entry);
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]!;
      const messageId = uniqueWireMessageId(`${entry.id}:${index}`, usedMessageIds);
      const updates: SessionUpdate[] = [];
      if (message.role === 'user') {
        const parts = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content;
        for (const part of parts.slice(0, MAX_MESSAGE_CONTENT_PARTS)) {
          if (part.type !== 'text') continue;
          updates.push({
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: truncateUtf8(part.text, MAX_REPLAY_TEXT_BYTES) },
            messageId,
          });
        }
      } else if (message.role === 'assistant') {
        for (const part of message.content.slice(0, MAX_MESSAGE_CONTENT_PARTS)) {
          if (part.type === 'text') {
            updates.push({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: truncateUtf8(part.text, MAX_REPLAY_TEXT_BYTES) },
              messageId,
            });
          } else if (part.type === 'thinking') {
            if (!part.redacted) {
              updates.push({
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text: truncateUtf8(part.thinking, MAX_REPLAY_TEXT_BYTES) },
                messageId,
              });
            }
          } else {
            const existing = tools.get(part.id);
            if (existing !== undefined && !existing.terminal) continue;
            if (tools.size >= MAX_REPLAY_TOOL_CALLS) {
              throw RequestError.internalError(
                { maxToolCalls: MAX_REPLAY_TOOL_CALLS },
                'Persisted session history contains too many tool calls',
              );
            }
            const safeName = truncateUtf8(part.name, MAX_TOOL_TITLE_BYTES * 2);
            const state = {
              wireId: toolCallIds.claim(part.id),
              name: safeName,
              args: part.arguments,
              terminal: false,
            };
            tools.set(part.id, state);
            const metadata = toolMetadata(cwd, safeName, part.arguments);
            updates.push({
              sessionUpdate: 'tool_call',
              toolCallId: state.wireId,
              title: metadata.title,
              kind: metadata.kind,
              status: 'pending',
              ...(metadata.locations.length === 0 ? {} : { locations: metadata.locations }),
              rawInput: boundToolInput(cwd, part.name, part.arguments),
            });
          }
        }
      } else if (message.role === 'toolResult') {
        let state = tools.get(message.toolCallId);
        if (state === undefined) {
          if (tools.size >= MAX_REPLAY_TOOL_CALLS) {
            throw RequestError.internalError(
              { maxToolCalls: MAX_REPLAY_TOOL_CALLS },
              'Persisted session history contains too many tool calls',
            );
          }
          state = {
            wireId: toolCallIds.claim(message.toolCallId),
            name: truncateUtf8(message.toolName, MAX_TOOL_TITLE_BYTES * 2),
            args: undefined,
            terminal: false,
          };
          tools.set(message.toolCallId, state);
          const metadata = toolMetadata(cwd, message.toolName, undefined);
          updates.push({
            sessionUpdate: 'tool_call',
            toolCallId: state.wireId,
            title: metadata.title,
            kind: metadata.kind,
            status: 'pending',
          });
        }
        if (!state.terminal) {
          state.terminal = true;
          const output = toolOutput(
            message,
            message.isError,
            toolHasSensitivePath(cwd, state.name, state.args),
          );
          updates.push({
            sessionUpdate: 'tool_call_update',
            toolCallId: state.wireId,
            status: message.isError ? 'failed' : 'completed',
            ...(output.content.length === 0 ? {} : { content: output.content }),
            ...(output.rawOutput === undefined ? {} : { rawOutput: output.rawOutput }),
          });
        }
      }
      for (const update of updates) {
        await notifyReplayUpdate(sessionId, update, client, isActive, budget);
      }
    }
  }
  for (const state of tools.values()) {
    if (state.terminal) continue;
    await notifyReplayUpdate(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: state.wireId,
      status: 'failed',
      content: textToolContent('Tool did not complete'),
    }, client, isActive, budget);
  }
}

export function toAcpPromptError(error: unknown): RequestError {
  if (error instanceof RequestError) {
    return new RequestError(error.code, sanitizeAcpErrorMessage(error));
  }
  return RequestError.internalError(undefined, sanitizeAcpErrorMessage(error));
}

export function sanitizeAcpErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const bounded = truncateUtf8(message, MAX_ERROR_SCAN_BYTES);
  return truncateUtf8(redactSensitiveText(bounded), MAX_ERROR_BYTES).replace(/\s+/gu, ' ').trim()
    || 'Operation failed';
}

async function notifyIfActive(
  sessionId: string,
  update: SessionUpdate,
  client: AgentContext,
  isActive: () => boolean,
): Promise<void> {
  if (!isActive()) {
    throw RequestError.requestCancelled({ sessionId }, 'Session closed while sending updates');
  }
  await client.notify(methods.client.session.update, { sessionId, update });
}

async function notifyReplayUpdate(
  sessionId: string,
  update: SessionUpdate,
  client: AgentContext,
  isActive: () => boolean,
  budget: { entries: number; updates: number; bytes: number },
): Promise<void> {
  budget.updates += 1;
  budget.bytes += Buffer.byteLength(JSON.stringify(update));
  if (budget.updates > MAX_REPLAY_UPDATES || budget.bytes > MAX_REPLAY_BYTES) {
    throw RequestError.internalError(
      { maxUpdates: MAX_REPLAY_UPDATES, maxBytes: MAX_REPLAY_BYTES },
      'Persisted session history exceeds the replay output limit',
    );
  }
  await notifyIfActive(sessionId, update, client, isActive);
}

function formatResourceLink(link: SupportedPromptBlock & { type: 'resource_link' }): string {
  return [
    `Resource link: ${link.name}`,
    `URI: ${link.uri}`,
    ...(link.description === undefined || link.description === null
      ? []
      : [`Description: ${link.description}`]),
  ].join('\n');
}

function boundedResourceField(value: string, label: string): string {
  assertNoNul(value, label);
  assertBoundedText(value, MAX_RESOURCE_FIELD_BYTES, label);
  return value;
}

function assertNoNul(value: string, label: string): void {
  if (value.includes('\0')) {
    throw RequestError.invalidParams(undefined, `${label} must not contain NUL bytes`);
  }
}

function assertBoundedText(value: string, maxBytes: number, label: string): void {
  if (Buffer.byteLength(value) > maxBytes) {
    throw RequestError.invalidParams({ maxBytes }, `${label} exceeds the maximum encoded size`);
  }
}

function isRedactedThinking(
  message: Extract<AgentSessionEvent, { type: 'message_update' }>['message'],
  contentIndex: number,
): boolean {
  if (message.role !== 'assistant') return false;
  const content = message.content[contentIndex];
  return content?.type === 'thinking' && content.redacted === true;
}

function toolMetadata(
  cwd: string,
  name: string,
  args: unknown,
): { readonly title: string; readonly kind: ToolKind; readonly locations: ToolCallLocation[] } {
  const kind = toolKind(name);
  const locations = toolLocations(cwd, name, args);
  const record = isRecord(args) ? args : {};
  const subject = kind === 'execute' ? firstString(record, ['command', 'cmd'])
    : kind === 'search' ? firstString(record, ['pattern', 'query'])
      : kind === 'fetch' ? firstString(record, ['url', 'uri'])
        : locations[0]?.path;
  const verb = kind === 'read' ? 'Read'
    : kind === 'edit' ? 'Edit'
      : kind === 'delete' ? 'Delete'
        : kind === 'move' ? 'Move'
          : kind === 'search' ? 'Search'
            : kind === 'execute' ? 'Run'
              : kind === 'fetch' ? 'Fetch'
                : kind === 'think' ? 'Reason'
                  : titleCase(name);
  const titleSubject = subject === undefined
    ? undefined
    : sanitizeTitle(truncateUtf8(subject, MAX_TOOL_TITLE_BYTES * 4));
  const title = (titleSubject ? `${verb} ${titleSubject}` : titleCase(name) || verb).trim();
  return { title: truncateUtf8(title, MAX_TOOL_TITLE_BYTES), kind, locations };
}

function toolKind(name: string): ToolKind {
  const normalized = name.toLowerCase();
  if (normalized === 'read' || normalized === 'ls' || normalized.includes('read_file')) return 'read';
  if (normalized.includes('delete') || normalized === 'rm') return 'delete';
  if (normalized.includes('move') || normalized.includes('rename')) return 'move';
  if (normalized === 'edit' || normalized === 'write' || normalized.includes('patch')) return 'edit';
  if (normalized.includes('grep') || normalized.includes('find') || normalized.includes('search')) return 'search';
  if (normalized.includes('bash') || normalized.includes('process') || normalized.includes('terminal') || normalized.includes('exec')) return 'execute';
  if (normalized.includes('fetch') || normalized.includes('browser') || normalized.includes('web')) return 'fetch';
  if (normalized.includes('think') || normalized.includes('reason')) return 'think';
  if (normalized.includes('mode')) return 'switch_mode';
  return 'other';
}

function toolLocations(cwd: string, name: string, args: unknown): ToolCallLocation[] {
  if (!isRecord(args)) return [];
  const values: string[] = [];
  for (const key of ['path', 'file_path', 'source', 'destination', 'target']) {
    const value = args[key];
    if (typeof value === 'string') values.push(value);
  }
  if (Array.isArray(args.paths)) {
    for (const value of args.paths) if (typeof value === 'string') values.push(value);
  }
  if (name.toLowerCase().includes('patch')) {
    const patch = firstString(args, ['input', 'patch', 'patchText']);
    if (patch) {
      for (const match of patch.slice(0, MAX_RAW_VALUE_BYTES * 2)
        .matchAll(/^\*\*\* (?:(?:Add|Delete|Update) File:|Move to:) (.+)$/gmu)) {
        if (match[1]) values.push(match[1]);
      }
    }
  }
  const lineValue = typeof args.line === 'number' ? args.line
    : typeof args.offset === 'number' ? args.offset : undefined;
  const line = lineValue !== undefined && Number.isSafeInteger(lineValue) && lineValue > 0
    ? lineValue
    : undefined;
  const locations: ToolCallLocation[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (
      locations.length >= MAX_LOCATIONS
      || Buffer.byteLength(value) > MAX_LOCATION_BYTES
      || value.includes('\0')
      || value.includes('://')
      || [...'*?{}[]'].some((character) => value.includes(character))
    ) continue;
    const path = resolve(cwd, value);
    if (Buffer.byteLength(path) > MAX_LOCATION_BYTES || seen.has(path)) continue;
    seen.add(path);
    locations.push({ path, ...(line === undefined ? {} : { line }) });
  }
  return locations;
}

function mutationFilePath(cwd: string, name: string, args: unknown): string | undefined {
  if (name !== 'edit' && name !== 'write') return undefined;
  if (
    !isRecord(args)
    || typeof args.path !== 'string'
    || args.path.includes('\0')
    || Buffer.byteLength(args.path) > MAX_LOCATION_BYTES
  ) return undefined;
  const path = resolve(cwd, args.path);
  return isWithin(cwd, path) && !isSensitivePath(path) ? path : undefined;
}

function snapshotTextFile(cwd: string, path: string): FileSnapshot | undefined {
  try {
    const root = realpathSync(cwd);
    let target: string;
    try {
      target = realpathSync(path);
    } catch (error) {
      if (!isMissingFile(error)) return undefined;
      const parent = realpathSync(dirname(path));
      if (!isWithin(root, parent)) return undefined;
      return { path, text: null };
    }
    if (!isWithin(root, target) || isSensitivePath(target)) return undefined;
    // AgentSession listeners are synchronous, so this bounded read must finish before tool execution resumes.
    const descriptor = openSync(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const beforeRead = fstatSync(descriptor);
      const openedTarget = realpathSync(target);
      const resolvedMetadata = statSync(openedTarget);
      if (
        !isWithin(root, openedTarget)
        || isSensitivePath(openedTarget)
        || !sameFile(resolvedMetadata, beforeRead)
        || !beforeRead.isFile()
        || beforeRead.size > MAX_DIFF_FILE_BYTES
      ) {
        return undefined;
      }
      const bytes = readFileSync(descriptor);
      if (bytes.byteLength > MAX_DIFF_FILE_BYTES) return undefined;
      const afterRead = fstatSync(descriptor);
      if (!sameFile(beforeRead, afterRead) || !sameFileVersion(beforeRead, afterRead)) return undefined;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (containsSensitiveText(text)) return undefined;
      return { path, text };
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return undefined;
  }
}

function fileDiff(
  before: FileSnapshot | undefined,
  after: FileSnapshot | undefined,
): ToolCallContent | undefined {
  if (before === undefined || after === undefined) return undefined;
  if (
    after.text === null
    || before.path !== after.path
    || before.text === after.text
  ) return undefined;
  return {
    type: 'diff',
    path: after.path,
    oldText: before.text,
    newText: after.text,
  };
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileVersion(left: Stats, right: Stats): boolean {
  return left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function toolOutput(value: unknown, isError: boolean, sensitive = false): ToolOutput {
  if (sensitive) {
    return {
      content: textToolContent('Sensitive tool output omitted'),
      rawOutput: '[redacted sensitive tool output]',
    };
  }
  const rawOutput = value === undefined ? undefined : boundProtocolValue(value);
  const content: ToolCallContent[] = [];
  let remaining = MAX_TOOL_CONTENT_BYTES;
  const blocks = isRecord(value) && Array.isArray(value.content)
    ? value.content.slice(0, MAX_TOOL_CONTENT_ITEMS)
    : [];
  for (const block of blocks) {
    if (remaining <= 0) break;
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      const text = truncateUtf8(redactSensitiveText(block.text), Math.min(remaining, MAX_UPDATE_TEXT_BYTES));
      remaining -= Buffer.byteLength(text);
      content.push({ type: 'content', content: { type: 'text', text } });
    } else if (isRecord(block) && block.type === 'image') {
      const mimeType = typeof block.mimeType === 'string' ? sanitizeTitle(block.mimeType) : 'image';
      const text = truncateUtf8(`[${mimeType} output omitted]`, remaining);
      remaining -= Buffer.byteLength(text);
      content.push({ type: 'content', content: { type: 'text', text } });
    }
  }
  if (content.length === 0 && isError) {
    const error = isRecord(value) && typeof value.error === 'string' ? value.error : value;
    content.push(...textToolContent(sanitizeAcpErrorMessage(error)));
  }
  return {
    content,
    ...(rawOutput === undefined ? {} : { rawOutput }),
  };
}

function textToolContent(text: string): ToolCallContent[] {
  return [{
    type: 'content',
    content: { type: 'text', text: truncateUtf8(redactSensitiveText(text), MAX_UPDATE_TEXT_BYTES) },
  }];
}

function boundProtocolValue(value: unknown): unknown {
  const state = { remaining: MAX_RAW_VALUE_BYTES, seen: new WeakSet<object>() };
  try {
    const bounded = boundValue(value, state, 0, '');
    const encoded = JSON.stringify(bounded) ?? 'null';
    if (Buffer.byteLength(encoded) <= MAX_RAW_VALUE_BYTES) return bounded;
    return { _felanTruncated: true, preview: truncateUtf8(encoded, MAX_RAW_VALUE_BYTES / 2) };
  } catch {
    return '[unserializable value]';
  }
}

function boundToolInput(cwd: string, name: string, value: unknown): unknown {
  if (!toolHasSensitivePath(cwd, name, value) || !isRecord(value)) {
    return boundProtocolValue(value);
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = [
      'destination',
      'file_path',
      'line',
      'offset',
      'path',
      'paths',
      'source',
      'target',
    ].includes(key) ? entry : '[redacted sensitive file content]';
  }
  return boundProtocolValue(redacted);
}

function boundValue(
  value: unknown,
  state: { remaining: number; seen: WeakSet<object> },
  depth: number,
  key: string,
): unknown {
  if (isSensitiveKey(key)) return '[redacted]';
  if (typeof value === 'string') {
    const result = truncateUtf8(redactSensitiveText(value), Math.min(MAX_RAW_STRING_BYTES, state.remaining));
    state.remaining -= Buffer.byteLength(result);
    return result;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (value === undefined) return null;
  if (typeof value !== 'object') return truncateUtf8(String(value), Math.min(256, state.remaining));
  if (depth >= MAX_RAW_DEPTH) return '[maximum depth reached]';
  if (state.seen.has(value)) return '[circular]';
  state.seen.add(value);
  if (Array.isArray(value)) {
    const result = value.slice(0, MAX_RAW_ENTRIES).map((entry) => (
      state.remaining <= 0 ? '[truncated]' : boundValue(entry, state, depth + 1, '')
    ));
    if (value.length > result.length) result.push(`[${value.length - result.length} items omitted]`);
    return result;
  }
  const result: Record<string, unknown> = {};
  try {
    const entries = Object.entries(value).slice(0, MAX_RAW_ENTRIES);
    for (const [entryKey, entry] of entries) {
      if (state.remaining <= 0) {
        result._felanTruncated = true;
        break;
      }
      result[truncateUtf8(entryKey, 512)] = boundValue(entry, state, depth + 1, entryKey);
    }
    if (Object.keys(value).length > entries.length) result._felanOmittedFields = true;
    return result;
  } catch {
    return '[unavailable value]';
  }
}

function wireToolCallId(id: string): string {
  if (id && Buffer.byteLength(id) <= MAX_TOOL_ID_BYTES && !/[\u0000-\u001f\u007f]/u.test(id)) return id;
  return `tool-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
}

function wireMessageId(id: string): string {
  if (id && Buffer.byteLength(id) <= MAX_MESSAGE_ID_BYTES && !/[\u0000-\u001f\u007f]/u.test(id)) {
    return id;
  }
  return `message-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
}

function uniqueWireMessageId(id: string, used: Set<string>): string {
  const preferred = wireMessageId(id);
  if (!used.has(preferred)) {
    used.add(preferred);
    return preferred;
  }
  let sequence = 1;
  while (true) {
    const candidate = `message-${createHash('sha256')
      .update(`${id}\0${sequence}`)
      .digest('hex')
      .slice(0, 32)}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    sequence += 1;
  }
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu, '[REDACTED_PRIVATE_KEY]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*$/gu, '[REDACTED_PRIVATE_KEY]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/gu, '[REDACTED_TOKEN]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/gu, '[REDACTED_ACCESS_KEY]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, '$1[REDACTED_TOKEN]')
    .replace(/(Basic\s+)[A-Za-z0-9+/=]+/giu, '$1[REDACTED_CREDENTIAL]')
    .replace(/((?:Set-)?Cookie\s*:)[^\r\n]*/giu, '$1 [REDACTED_COOKIE]')
    .replace(/(_authToken\s*=\s*)[^\s]+/giu, '$1[REDACTED_TOKEN]')
    .replace(/(\b[A-Z0-9_]{0,128}(?:API_KEY|SECRET_ACCESS_KEY|ACCESS_TOKEN|REFRESH_TOKEN|SESSION_TOKEN|PASSWORD|CLIENT_SECRET)\s*=\s*)[^\s]+/giu, '$1[REDACTED_SECRET]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}]+/giu, '$1[REDACTED_SECRET]')
    .replace(/((?:--)?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|authorization)\s+)[^\s]+/giu, '$1[REDACTED_SECRET]')
    .replace(/([?&](?:code|state|token|access_token|refresh_token|client_secret)=)[^&#\s]*/giu, '$1[REDACTED_SECRET]')
    .replace(/https?:\/\/[^\s)]+/giu, redactUrl)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '');
}

function containsSensitiveText(value: string): boolean {
  return redactSensitiveText(value) !== value;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/giu, '').toLowerCase();
  return SENSITIVE_KEYS.has(normalized)
    || normalized.endsWith('apikey')
    || normalized.endsWith('cookie')
    || normalized.endsWith('password')
    || normalized.endsWith('token')
    || normalized.includes('secret')
    || normalized.includes('privatekey');
}

function isSensitivePath(path: string): boolean {
  return /(?:^|[/\\])(?:\.aws|\.docker|\.git-credentials|\.netrc|\.npmrc|\.pypirc|\.ssh|\.env|auth|credentials?|id_(?:dsa|ecdsa|ed25519|rsa)|secrets?|[^/\\]+\.(?:key|pem))(?:[./\\]|$)/iu.test(path);
}

function toolHasSensitivePath(cwd: string, name: string, args: unknown): boolean {
  if (!isRecord(args)) return false;
  for (const key of ['path', 'file_path', 'source', 'destination', 'target']) {
    const value = args[key];
    if (
      typeof value === 'string'
      && Buffer.byteLength(value) <= MAX_LOCATION_BYTES
      && !value.includes('\0')
      && isSensitivePath(resolve(cwd, value))
    ) {
      return true;
    }
  }
  if (Array.isArray(args.paths) && args.paths.some((value) => (
    typeof value === 'string'
    && Buffer.byteLength(value) <= MAX_LOCATION_BYTES
    && !value.includes('\0')
    && isSensitivePath(resolve(cwd, value))
  ))) return true;
  if (name.toLowerCase().includes('patch')) {
    const patch = firstString(args, ['input', 'patch', 'patchText']);
    if (patch) {
      const boundedPatch = patch.slice(0, MAX_RAW_VALUE_BYTES * 2);
      for (const match of boundedPatch.matchAll(/^\*\*\* (?:(?:Add|Delete|Update) File:|Move to:) (.+)$/gmu)) {
        const path = match[1];
        if (path && isSensitivePath(resolve(cwd, path))) return true;
      }
    }
  }
  return false;
}

function sanitizeTitle(value: string): string {
  return redactSensitiveText(value).replace(/\s+/gu, ' ').trim();
}

function titleCase(value: string): string {
  const words = value.replace(/[_-]+/gu, ' ').trim();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : 'Tool';
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = '[redacted]';
    if (url.password) url.password = '[redacted]';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[redacted URL]';
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  const limit = Math.max(0, Math.floor(maxBytes));
  const encoded = Buffer.from(value);
  if (encoded.byteLength <= limit) return value;
  if (limit === 0) return '';
  const marker = Buffer.byteLength(TRUNCATION_MARKER) < limit ? TRUNCATION_MARKER : '';
  const contentLimit = limit - Buffer.byteLength(marker);
  const prefix = encoded.subarray(0, contentLimit).toString('utf8').replace(/\uFFFD$/u, '');
  return `${prefix}${marker}`;
}

function isWithin(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target));
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
