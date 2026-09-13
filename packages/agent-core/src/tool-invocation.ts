import {
  type AgentSession,
  type AgentToolResult,
  type AgentToolUpdateCallback,
} from '@earendil-works/pi-coding-agent';
import { type AssistantMessage, validateToolArguments, uuidv7 } from '@earendil-works/pi-ai';

export interface FelanToolInvocationOptions {
  readonly signal?: AbortSignal;
  readonly onUpdate?: AgentToolUpdateCallback<unknown>;
}

export interface FelanToolInvocationResult extends AgentToolResult<unknown> {
  readonly toolCallId: string;
  readonly isError: boolean;
}

export interface FelanToolInvoker {
  invoke(
    toolName: string,
    input: unknown,
    options?: FelanToolInvocationOptions,
  ): Promise<FelanToolInvocationResult>;
}

export class SessionToolInvoker implements FelanToolInvoker {
  #session: AgentSession | undefined;
  #sequentialTail: Promise<void> = Promise.resolve();

  bind(session: AgentSession): void {
    if (this.#session && this.#session !== session) {
      throw new Error('Tool invoker is already bound to another session');
    }
    this.#session = session;
  }

  async invoke(
    toolName: string,
    input: unknown,
    options: FelanToolInvocationOptions = {},
  ): Promise<FelanToolInvocationResult> {
    const session = this.#session;
    if (!session) throw new Error('Nested tool invocation requires Agent Core session composition');

    const tool = session.agent.state.tools.find((candidate) => candidate.name === toolName);
    const toolCallId = uuidv7();
    if (!tool) return errorResult(toolCallId, `Tool ${JSON.stringify(toolName)} is unavailable`);

    if (tool.executionMode === 'sequential') {
      const previous = this.#sequentialTail;
      let release!: () => void;
      this.#sequentialTail = new Promise<void>((resolve) => { release = resolve; });
      const invocation = (async () => {
        await previous;
        try {
          return await this.#invoke(session, toolName, input, toolCallId, options);
        } finally {
          release();
        }
      })();
      if (await abortedWhileWaiting(previous, options.signal)) {
        return errorResult(toolCallId, 'Operation aborted');
      }
      return invocation;
    }
    return this.#invoke(session, toolName, input, toolCallId, options);
  }

  async #invoke(
    session: AgentSession,
    toolName: string,
    input: unknown,
    toolCallId: string,
    options: FelanToolInvocationOptions,
  ): Promise<FelanToolInvocationResult> {
    const agent = session.agent;
    const state = agent.state;
    const tool = state.tools.find((candidate) => candidate.name === toolName);
    if (!tool) return errorResult(toolCallId, `Tool ${JSON.stringify(toolName)} is unavailable`);
    if (options.signal?.aborted) return errorResult(toolCallId, 'Operation aborted');

    const parent = lastAssistantMessage(state.messages);
    if (!parent) return errorResult(toolCallId, 'Nested tool invocation requires an active assistant turn');

    const toolCall = {
      type: 'toolCall' as const,
      id: toolCallId,
      name: toolName,
      arguments: isRecord(input) ? input : {},
    };
    const assistantMessage: AssistantMessage = { ...parent, content: [toolCall] };
    const context = {
      systemPrompt: state.systemPrompt,
      messages: [...state.messages],
      tools: [...state.tools],
    };

    let args: unknown;
    try {
      const preparedInput = tool.prepareArguments ? tool.prepareArguments(input) : input;
      args = validateToolArguments(tool, {
        ...toolCall,
        arguments: preparedInput as Record<string, unknown>,
      });
      const decision = await agent.beforeToolCall?.({
        assistantMessage,
        toolCall,
        args,
        context,
      }, options.signal);
      if (options.signal?.aborted) return errorResult(toolCallId, 'Operation aborted');
      if (decision?.block) {
        return errorResult(
          toolCallId,
          decision.reason || 'Tool execution was blocked',
          decision.terminate === true,
        );
      }
    } catch (error) {
      return errorResult(toolCallId, errorMessage(error));
    }

    let acceptingUpdates = true;
    let result: AgentToolResult<unknown>;
    let isError = false;
    try {
      result = await tool.execute(toolCallId, args, options.signal, (update) => {
        if (acceptingUpdates) options.onUpdate?.(update);
      });
    } catch (error) {
      result = toolError(errorMessage(error));
      isError = true;
    } finally {
      acceptingUpdates = false;
    }

    if (agent.afterToolCall) {
      try {
        const patch = await agent.afterToolCall({
          assistantMessage,
          toolCall,
          args,
          result,
          isError,
          context,
        }, options.signal);
        if (patch) {
          result = {
            ...result,
            content: patch.content ?? result.content,
            details: patch.details ?? result.details,
            ...(patch.usage === undefined && result.usage === undefined
              ? {}
              : { usage: patch.usage ?? result.usage }),
            ...(patch.terminate === undefined && result.terminate === undefined
              ? {}
              : { terminate: patch.terminate ?? result.terminate }),
          };
          isError = patch.isError ?? isError;
        }
      } catch (error) {
        result = toolError(errorMessage(error));
        isError = true;
      }
    }

    return {
      ...result,
      content: result.content ?? [],
      toolCallId,
      isError,
    };
  }
}

function abortedWhileWaiting(
  previous: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (!signal) return previous.then(() => false);
  if (signal.aborted) return Promise.resolve(true);

  return new Promise((resolve) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void previous.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    });
  });
}

function lastAssistantMessage(messages: readonly unknown[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      typeof message === 'object'
      && message !== null
      && Reflect.get(message, 'role') === 'assistant'
    ) return message as AssistantMessage;
  }
  return undefined;
}

function errorResult(
  toolCallId: string,
  message: string,
  terminate = false,
): FelanToolInvocationResult {
  return {
    ...toolError(message),
    ...(terminate ? { terminate: true } : {}),
    toolCallId,
    isError: true,
  };
}

function toolError(message: string): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text: message }],
    details: {},
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
