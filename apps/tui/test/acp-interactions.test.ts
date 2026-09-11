import type { AgentContext } from '@agentclientprotocol/sdk';
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  ToolCallEvent,
  ToolCallEventResult,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { AcpSessionInteractions } from '../src/acp/interactions.js';
import { AcpToolCallIdRegistry } from '../src/acp/session-updates.js';

type ToolCallHandler = ExtensionHandler<ToolCallEvent, ToolCallEventResult>;

describe('ACP extension interactions', () => {
  it('maps Pi selectors, confirmations, inputs, and editors to bounded ACP forms', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ action: 'accept', content: { value: 'second' } })
      .mockResolvedValueOnce({ action: 'accept', content: { value: true } })
      .mockResolvedValueOnce({ action: 'accept', content: { value: 'typed' } })
      .mockResolvedValueOnce({ action: 'accept', content: { value: 'edited' } });
    const interactions = createInteractions(request, true);
    const ui = interactions.uiContext!;

    await expect(ui.select('Choose', ['first', 'second'])).resolves.toBe('second');
    await expect(ui.confirm('Confirm', 'Proceed?')).resolves.toBe(true);
    await expect(ui.input('Question', 'Answer here')).resolves.toBe('typed');
    await expect(ui.editor('Plan', 'draft')).resolves.toBe('edited');

    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls[0]?.[0]).toBe('elicitation/create');
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      mode: 'form',
      sessionId: 'root-session',
      message: 'Choose',
      requestedSchema: {
        type: 'object',
        properties: {
          value: { type: 'string', enum: ['first', 'second'] },
        },
        required: ['value'],
      },
    });
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      requestedSchema: { properties: { value: { type: 'boolean' } } },
    });
    expect(request.mock.calls[2]?.[1]).toMatchObject({
      requestedSchema: {
        properties: { value: { type: 'string', description: 'Answer here' } },
      },
    });
    expect(request.mock.calls[3]?.[1]).toMatchObject({
      requestedSchema: { properties: { value: { default: 'draft' } } },
    });
  });

  it('keeps form UI unavailable when the client did not advertise it', () => {
    const request = vi.fn();
    const interactions = createInteractions(request, false);

    expect(interactions.uiContext).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it('aborts a pending form on session cancellation and recovers for the next prompt', async () => {
    const pendingSignals: AbortSignal[] = [];
    const request = vi.fn((_method, _params, options: { cancellationSignal: AbortSignal }) => {
      pendingSignals.push(options.cancellationSignal);
      return new Promise(() => {});
    });
    const interactions = createInteractions(request, true);
    const answers = Array.from(
      { length: 32 },
      (_, index) => interactions.uiContext!.input(`Question ${index}`),
    );
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(32));

    interactions.cancelPending();

    await expect(Promise.all(answers)).resolves.toEqual(Array.from({ length: 32 }));
    expect(pendingSignals.every(({ aborted }) => aborted)).toBe(true);

    const resumedRequest = vi.fn(async () => ({ action: 'accept', content: { value: 'ready' } }));
    interactions.beginPrompt({ request: resumedRequest } as unknown as AgentContext);
    await expect(interactions.uiContext!.input('Question')).resolves.toBe('ready');
  });

  it('allows known read-only tools without prompting and gates mutation and unknown tools', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
      .mockResolvedValueOnce({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
    const toolCallIds = new AcpToolCallIdRegistry();
    toolCallIds.claim('write-id');
    const interactions = createInteractions(request, true, toolCallIds);
    const handler = await getToolCallHandler(interactions);
    const readContext = toolContext();

    expect(await handler({
      type: 'tool_call',
      toolCallId: 'read-id',
      toolName: 'read',
      input: { path: '/tmp/file' },
    }, readContext.context)).toBeUndefined();
    expect(request).not.toHaveBeenCalled();

    const writeContext = toolContext();
    await expect(handler({
      type: 'tool_call',
      toolCallId: 'write-id',
      toolName: 'write',
      input: { path: '/tmp/file', content: 'new text' },
    }, writeContext.context)).resolves.toBeUndefined();
    expect(writeContext.abort).not.toHaveBeenCalled();
    expect(request.mock.calls[0]?.[0]).toBe('session/request_permission');
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      sessionId: 'root-session',
      toolCall: {
        toolCallId: 'write-id',
        kind: 'edit',
        status: 'pending',
      },
      options: [
        { optionId: 'allow-once', kind: 'allow_once' },
        { optionId: 'reject-once', kind: 'reject_once' },
      ],
    });

    const unknownContext = toolContext();
    await expect(handler({
      type: 'tool_call',
      toolCallId: 'unknown-id',
      toolName: 'future_action',
      input: { authorization: 'Bearer top-secret-value' },
    }, unknownContext.context)).resolves.toEqual({
      block: true,
      reason: 'The tool call was not approved by the user.',
      terminate: true,
    });
    expect(unknownContext.abort).toHaveBeenCalledOnce();
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      toolCall: { rawInput: { authorization: '[redacted]' } },
    });
  });

  it('fails closed on malformed responses, client failures, and cancelled permissions', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ outcome: { outcome: 'selected', optionId: 'unexpected' } })
      .mockRejectedValueOnce(new Error('client disconnected'));
    const interactions = createInteractions(request, true);
    const handler = await getToolCallHandler(interactions);

    for (const id of ['malformed', 'failed']) {
      const callContext = toolContext();
      await expect(handler({
        type: 'tool_call',
        toolCallId: id,
        toolName: 'bash',
        input: { command: 'echo', args: [] },
      }, callContext.context)).resolves.toMatchObject({ block: true, terminate: true });
      expect(callContext.abort).toHaveBeenCalledOnce();
    }

    interactions.cancelPending();
    const cancelledContext = toolContext();
    await expect(handler({
      type: 'tool_call',
      toolCallId: 'cancelled',
      toolName: 'write',
      input: { path: '/tmp/file', content: 'text' },
    }, cancelledContext.context)).resolves.toMatchObject({ block: true, terminate: true });
    expect(cancelledContext.abort).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('bounds detached requests when a peer repeatedly ignores cancellation', async () => {
    const request = vi.fn(() => new Promise(() => {}));
    const interactions = createInteractions(request, true);

    for (let cycle = 0; cycle < 4; cycle += 1) {
      const pending = Array.from(
        { length: 32 },
        (_, index) => interactions.uiContext!.input(`Question ${cycle}-${index}`),
      );
      interactions.cancelPending();
      await Promise.all(pending);
      interactions.beginPrompt({ request } as unknown as AgentContext);
    }

    await expect(interactions.uiContext!.input('One too many')).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(128);
  });

  it('allocates session-unique permission IDs for subagent tool calls', async () => {
    const request = vi.fn(async () => ({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    }));
    const toolCallIds = new AcpToolCallIdRegistry();
    expect(toolCallIds.claim('shared-id')).toBe('shared-id');
    const interactions = createInteractions(request, true, toolCallIds);
    const handler = await getToolCallHandler(interactions);

    await handler({
      type: 'tool_call',
      toolCallId: 'shared-id',
      toolName: 'write',
      input: { path: '/tmp/root', content: 'root' },
    }, toolContext('root-session').context);
    await handler({
      type: 'tool_call',
      toolCallId: 'shared-id',
      toolName: 'write',
      input: { path: '/tmp/child', content: 'child' },
    }, toolContext('child-session').context);
    await handler({
      type: 'tool_call',
      toolCallId: 'shared-id',
      toolName: 'write',
      input: { path: '/tmp/root', content: 'root' },
    }, toolContext('root-session').context);

    expect(request.mock.calls[0]?.[1].toolCall.toolCallId).toBe('shared-id');
    expect(request.mock.calls[1]?.[1].toolCall.toolCallId).not.toBe('shared-id');
    expect(request.mock.calls[2]?.[1].toolCall.toolCallId).toBe('shared-id');
  });
});

function createInteractions(
  request: ReturnType<typeof vi.fn>,
  supportsFormElicitation: boolean,
  toolCallIds = new AcpToolCallIdRegistry(),
): AcpSessionInteractions {
  const interactions = new AcpSessionInteractions({
    client: { request } as unknown as AgentContext,
    supportsFormElicitation,
    toolCallIds,
  });
  interactions.bindSession('root-session');
  return interactions;
}

async function getToolCallHandler(interactions: AcpSessionInteractions): Promise<ToolCallHandler> {
  let handler: ToolCallHandler | undefined;
  const extension = interactions.inlineExtension;
  const factory = typeof extension === 'function' ? extension : extension.factory;
  await factory({
    on: (event: string, candidate: unknown) => {
      if (event === 'tool_call') handler = candidate as ToolCallHandler;
    },
  } as unknown as ExtensionAPI);
  if (handler === undefined) throw new Error('Tool-call handler was not registered');
  return handler;
}

function toolContext(sessionId = 'root-session'): {
  readonly context: ExtensionContext;
  readonly abort: ReturnType<typeof vi.fn>;
} {
  const abort = vi.fn();
  return {
    context: {
      cwd: '/tmp',
      signal: undefined,
      sessionManager: { getSessionId: () => sessionId },
      abort,
    } as unknown as ExtensionContext,
    abort,
  };
}
