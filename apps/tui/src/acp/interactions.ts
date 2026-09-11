import {
  methods,
  type AgentContext,
  type CreateElicitationResponse,
  type ElicitationSchema,
} from '@agentclientprotocol/sdk';
import type {
  AgentSession,
  CreateAgentCoreSessionOptions,
} from '@felan-ai/agent-core';
import {
  AcpToolCallIdRegistry,
  createAcpToolCallUpdate,
} from './session-updates.js';

const MAX_PENDING_REQUESTS = 32;
const MAX_DETACHED_REQUESTS = 128;
const MAX_MESSAGE_BYTES = 192 * 1024;
const MAX_FIELD_LABEL_BYTES = 8 * 1024;
const MAX_OPTION_BYTES = 2 * 1024;
const MAX_OPTIONS = 100;
const MAX_VALUE_LENGTH = 32 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;
const ALLOW_ONCE = 'allow-once';
const REJECT_ONCE = 'reject-once';
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

const SAFE_TOOL_NAMES = new Set([
  'TaskGet',
  'TaskList',
  'ask_user',
  'codebase_memory',
  'enter_prewalk',
  'exit_plan_mode',
  'find',
  'get_subagent_result',
  'grep',
  'list_background_bash',
  'list_subagents',
  'ls',
  'read',
  'read_background_bash',
  'read_symbol',
  'search_and_read_symbols',
  'search_code',
  'wait_background_bash',
]);

type InlineExtension = NonNullable<
  CreateAgentCoreSessionOptions['inlineExtensions']
>[number];
type ExtensionUiContext = NonNullable<
  NonNullable<Parameters<AgentSession['bindExtensions']>[0]>['uiContext']
>;
type ExtensionTheme = ExtensionUiContext['theme'];

export interface AcpSessionInteractionsOptions {
  readonly client: AgentContext;
  readonly supportsFormElicitation: boolean;
  readonly toolCallIds: AcpToolCallIdRegistry;
}

export class AcpSessionInteractions {
  readonly #supportsFormElicitation: boolean;
  readonly #toolCallIds: AcpToolCallIdRegistry;
  readonly #activeRequests = new Set<symbol>();
  readonly #detachedRequests = new Set<Promise<unknown>>();
  #client: AgentContext;
  #sessionId: string | undefined;
  #requestController = new AbortController();
  #cancelled = false;
  #closed = false;

  readonly inlineExtension: InlineExtension = {
    name: '@felan-ai/felan/acp-action-permissions',
    hidden: true,
    factory: (pi) => {
      pi.on('tool_call', (event, ctx) => {
        if (SAFE_TOOL_NAMES.has(event.toolName)) return undefined;
        return this.#authorizeToolCall(
          event.toolCallId,
          event.toolName,
          event.input,
          ctx.cwd,
          ctx.sessionManager.getSessionId(),
          ctx.signal,
          () => ctx.abort(),
        );
      });
    },
  };

  readonly #uiContext: ExtensionUiContext;

  constructor(options: AcpSessionInteractionsOptions) {
    this.#client = options.client;
    this.#supportsFormElicitation = options.supportsFormElicitation;
    this.#toolCallIds = options.toolCallIds;
    this.#uiContext = this.#createUiContext();
  }

  get uiContext(): ExtensionUiContext | undefined {
    return this.#supportsFormElicitation ? this.#uiContext : undefined;
  }

  bindSession(sessionId: string): void {
    if (this.#sessionId !== undefined && this.#sessionId !== sessionId) {
      throw new Error('ACP interaction channel is already bound to another session');
    }
    this.#sessionId = sessionId;
  }

  beginPrompt(client: AgentContext): void {
    if (this.#closed) return;
    this.#client = client;
    if (this.#cancelled) {
      this.#requestController = new AbortController();
      this.#cancelled = false;
    }
  }

  cancelPending(): void {
    if (this.#closed || this.#cancelled) return;
    this.#cancelled = true;
    this.#requestController.abort();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#requestController.abort();
  }

  #createUiContext(): ExtensionUiContext {
    return {
      select: async (title, options, requestOptions) => {
        if (
          options.length === 0
          || options.length > MAX_OPTIONS
          || new Set(options).size !== options.length
          || options.some((option) => !isBoundedString(option, MAX_OPTION_BYTES))
        ) return undefined;
        const response = await this.#elicit(
          title,
          {
            type: 'object',
            properties: {
              value: {
                type: 'string',
                title: boundString(title, MAX_FIELD_LABEL_BYTES),
                enum: options,
              },
            },
            required: ['value'],
          },
          requestOptions?.signal,
          requestOptions?.timeout,
        );
        const value = acceptedValue(response);
        return typeof value === 'string' && options.includes(value) ? value : undefined;
      },
      confirm: async (title, message, requestOptions) => {
        const response = await this.#elicit(
          `${title}\n\n${message}`,
          {
            type: 'object',
            properties: {
              value: {
                type: 'boolean',
                title: boundString(title, MAX_FIELD_LABEL_BYTES),
                description: boundString(message, MAX_MESSAGE_BYTES),
              },
            },
            required: ['value'],
          },
          requestOptions?.signal,
          requestOptions?.timeout,
        );
        return acceptedValue(response) === true;
      },
      input: async (title, placeholder, requestOptions) => {
        if (placeholder !== undefined && !isSafeBoundedText(placeholder, MAX_MESSAGE_BYTES)) {
          return undefined;
        }
        const response = await this.#elicit(
          title,
          stringSchema(title, placeholder),
          requestOptions?.signal,
          requestOptions?.timeout,
        );
        const value = acceptedValue(response);
        return isBoundedValue(value) ? value : undefined;
      },
      editor: async (title, prefill) => {
        if (prefill !== undefined && !isBoundedValue(prefill)) return undefined;
        const response = await this.#elicit(
          title,
          stringSchema(title, undefined, prefill),
        );
        const value = acceptedValue(response);
        return isBoundedValue(value) ? value : undefined;
      },
      notify: () => {},
      onTerminalInput: () => () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      custom: async <T>() => undefined as T,
      pasteToEditor: () => {},
      setEditorText: () => {},
      getEditorText: () => '',
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      theme: neutralTheme,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: 'Themes are unavailable over ACP' }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

  async #elicit(
    message: string,
    requestedSchema: ElicitationSchema,
    signal?: AbortSignal,
    timeout?: number,
  ): Promise<CreateElicitationResponse | undefined> {
    if (!this.#supportsFormElicitation || !isBoundedString(message, MAX_MESSAGE_BYTES)) {
      return undefined;
    }
    const sessionId = this.#sessionId;
    if (sessionId === undefined) return undefined;
    return this.#request(
      (cancellationSignal) => this.#client.request(
        methods.client.elicitation.create,
        {
          mode: 'form',
          sessionId,
          message,
          requestedSchema,
        },
        { cancellationSignal },
      ),
      signal,
      timeout,
    );
  }

  async #authorizeToolCall(
    providerToolCallId: string,
    toolName: string,
    input: unknown,
    cwd: string,
    sourceSessionId: string,
    signal: AbortSignal | undefined,
    abort: () => void,
  ): Promise<{ block: true; reason: string; terminate: true } | undefined> {
    const sessionId = this.#sessionId;
    if (sessionId === undefined) return denyToolCall(abort);
    const wireId = sourceSessionId === sessionId
      ? this.#toolCallIds.current(providerToolCallId) ?? this.#toolCallIds.claim(providerToolCallId)
      : this.#toolCallIds.claim(providerToolCallId, sourceSessionId);
    const response = await this.#request(
      (cancellationSignal) => this.#client.request(
        methods.client.session.requestPermission,
        {
          sessionId,
          toolCall: {
            ...createAcpToolCallUpdate(cwd, wireId, toolName, input),
            status: 'pending',
          },
          options: [
            { optionId: ALLOW_ONCE, name: 'Allow once', kind: 'allow_once' },
            { optionId: REJECT_ONCE, name: 'Reject once', kind: 'reject_once' },
          ],
        },
        { cancellationSignal },
      ),
      signal,
    );
    if (isAllowOnceResponse(response)) return undefined;
    return denyToolCall(abort);
  }

  async #request<T>(
    send: (signal: AbortSignal) => Promise<T>,
    externalSignal?: AbortSignal,
    timeout?: number,
  ): Promise<T | undefined> {
    if (
      this.#closed
      || this.#cancelled
      || this.#activeRequests.size >= MAX_PENDING_REQUESTS
      || this.#detachedRequests.size >= MAX_DETACHED_REQUESTS
      || externalSignal?.aborted
      || (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0))
    ) return undefined;

    const timeoutController = new AbortController();
    const signals = [this.#requestController.signal, timeoutController.signal];
    if (externalSignal !== undefined) signals.push(externalSignal);
    const signal = AbortSignal.any(signals);
    if (signal.aborted) return undefined;
    const requestToken = Symbol('request');
    this.#activeRequests.add(requestToken);

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (timeout !== undefined && Number.isFinite(timeout) && timeout > 0) {
      timeoutHandle = setTimeout(
        () => timeoutController.abort(),
        Math.min(Math.ceil(timeout), MAX_TIMEOUT_MS),
      );
    }

    let wireRequest: Promise<T>;
    try {
      wireRequest = send(signal);
    } catch {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      this.#activeRequests.delete(requestToken);
      return undefined;
    }
    let wireSettled = false;
    const detachedRequests = this.#detachedRequests;
    void wireRequest.then(
      () => {
        wireSettled = true;
        detachedRequests.delete(wireRequest);
      },
      () => {
        wireSettled = true;
        detachedRequests.delete(wireRequest);
      },
    );

    const aborted = Symbol('aborted');
    let abortListener: (() => void) | undefined;
    const abortPromise = new Promise<typeof aborted>((resolve) => {
      abortListener = () => resolve(aborted);
      if (signal.aborted) abortListener();
      else signal.addEventListener('abort', abortListener, { once: true });
    });
    try {
      const result = await Promise.race([wireRequest, abortPromise]);
      if (result !== aborted) return result;
      if (!wireSettled) this.#detachedRequests.add(wireRequest);
      return undefined;
    } catch {
      return undefined;
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (abortListener !== undefined) signal.removeEventListener('abort', abortListener);
      this.#activeRequests.delete(requestToken);
    }
  }
}

function stringSchema(
  title: string,
  description?: string,
  defaultValue?: string,
): ElicitationSchema {
  return {
    type: 'object',
    properties: {
      value: {
        type: 'string',
        title: boundString(title, MAX_FIELD_LABEL_BYTES),
        maxLength: MAX_VALUE_LENGTH,
        ...(description === undefined
          ? {}
          : { description: boundString(description, MAX_MESSAGE_BYTES) }),
        ...(defaultValue === undefined ? {} : { default: defaultValue }),
      },
    },
    required: ['value'],
  };
}

function acceptedValue(response: CreateElicitationResponse | undefined): unknown {
  if (response?.action !== 'accept') return undefined;
  const content: unknown = response.content;
  return typeof content === 'object' && content !== null && 'value' in content
    ? content.value
    : undefined;
}

function isAllowOnceResponse(response: unknown): boolean {
  if (typeof response !== 'object' || response === null || !('outcome' in response)) return false;
  const outcome: unknown = response.outcome;
  return typeof outcome === 'object'
    && outcome !== null
    && 'outcome' in outcome
    && outcome.outcome === 'selected'
    && 'optionId' in outcome
    && outcome.optionId === ALLOW_ONCE;
}

function isBoundedValue(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= MAX_VALUE_LENGTH
    && isSafeBoundedText(value, MAX_VALUE_LENGTH * 4);
}

function isBoundedString(value: string, maxBytes: number): boolean {
  return value.length > 0 && isSafeBoundedText(value, maxBytes);
}

function isSafeBoundedText(value: string, maxBytes: number): boolean {
  return Buffer.byteLength(value, 'utf8') <= maxBytes
    && !UNSAFE_CONTROL_CHARACTERS.test(value);
}

function boundString(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  return Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8').replace(/�$/u, '');
}

function denyToolCall(abort: () => void): {
  block: true;
  reason: string;
  terminate: true;
} {
  try {
    abort();
  } catch {}
  return {
    block: true,
    reason: 'The tool call was not approved by the user.',
    terminate: true,
  };
}

const neutralTheme = {
  fg: (_color: unknown, text: string) => text,
  bg: (_color: unknown, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  inverse: (text: string) => text,
  strikethrough: (text: string) => text,
  getFgAnsi: () => '',
  getBgAnsi: () => '',
  getColorMode: () => 'truecolor',
  getThinkingBorderColor: () => (text: string) => text,
  getBashModeBorderColor: () => (text: string) => text,
} as unknown as ExtensionTheme;
