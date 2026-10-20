import {
  type AgentContext,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import {
  SessionManager,
  type AgentSessionEvent,
  type AssistantMessage,
} from '@felan-ai/agent-core';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AcpPromptUpdateStream,
  AcpToolCallIdRegistry,
  prepareAcpPrompt,
  replayAcpSessionEntries,
  sanitizeAcpErrorMessage,
} from '../src/acp/session-updates.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('ACP session updates', () => {
  it('preserves supported prompt block order and rejects unsupported or oversized input', () => {
    const prepared = prepareAcpPrompt([
      { type: 'text', text: 'first' },
      {
        type: 'resource_link',
        name: 'Guide',
        uri: 'file:///workspace/GUIDE.md',
        description: 'Project guide',
        _meta: { ignored: true },
      },
      { type: 'text', text: 'last' },
    ]);

    expect(prepared.blocks).toEqual([
      { type: 'text', text: 'first' },
      {
        type: 'resource_link',
        name: 'Guide',
        uri: 'file:///workspace/GUIDE.md',
        description: 'Project guide',
      },
      { type: 'text', text: 'last' },
    ]);
    expect(prepared.text).toBe([
      'first',
      'Resource link: Guide\nURI: file:///workspace/GUIDE.md\nDescription: Project guide',
      'last',
    ].join('\n'));
    expect(() => prepareAcpPrompt([{
      type: 'image',
      data: 'AA==',
      mimeType: 'image/png',
    }])).toThrow('Unsupported prompt content type: image');
    expect(() => prepareAcpPrompt([{
      type: 'text',
      text: '€'.repeat(22_000),
    }])).toThrow('Prompt text block exceeds the maximum encoded size');
    expect(() => prepareAcpPrompt([{
      type: 'text',
      text: 'small',
      _meta: { padding: 'x'.repeat(600 * 1024) },
    }])).toThrow('Prompt payload exceeds the maximum encoded size');
  });

  it('streams ordered text and thought deltas without duplicating finalized content', async () => {
    const harness = updateHarness();
    const turn = createTurn(harness.context);
    const partial = assistantMessage([
      { type: 'text', text: 'Hello' },
      { type: 'thinking', thinking: 'Reasoning' },
    ]);

    turn.emitPrompt([{ type: 'text', text: 'Question' }]);
    turn.handle({ type: 'message_start', message: assistantMessage([]) });
    turn.handle(messageUpdate(partial, { type: 'text_delta', contentIndex: 0, delta: 'Hel', partial }));
    turn.handle(messageUpdate(partial, { type: 'thinking_delta', contentIndex: 1, delta: 'Reasoning', partial }));
    turn.handle(messageUpdate(partial, { type: 'text_delta', contentIndex: 0, delta: 'lo', partial }));
    turn.handle({ type: 'message_end', message: partial });
    turn.finish(false);
    await turn.flush();

    expect(harness.updates.map(({ update }) => update.sessionUpdate)).toEqual([
      'user_message_chunk',
      'agent_message_chunk',
      'agent_thought_chunk',
      'agent_message_chunk',
    ]);
    expect(harness.updates.map(({ update }) => (
      'content' in update && update.content && 'text' in update.content ? update.content.text : undefined
    ))).toEqual(['Question', 'Hel', 'Reasoning', 'lo']);
    const assistantIds = harness.updates
      .map(({ update }) => 'messageId' in update ? update.messageId : undefined)
      .slice(1);
    expect(new Set(assistantIds).size).toBe(1);
  });

  it('emits bounded, redacted, monotonic tool updates and a safe file diff', async () => {
    const cwd = await temporaryDirectory();
    const path = join(cwd, 'file.txt');
    await writeFile(path, 'before\n');
    const harness = updateHarness();
    const turn = createTurn(harness.context, cwd);

    turn.handle({
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'write',
      args: { path: 'file.txt', password: 'do-not-send' },
    });
    await writeFile(path, 'after\n');
    turn.handle({
      type: 'tool_execution_update',
      toolCallId: 'tool-1',
      toolName: 'write',
      args: { path: 'file.txt', password: 'do-not-send' },
      partialResult: {
        content: [{ type: 'text', text: 'Bearer secret-token' }],
        details: { token: 'partial-secret' },
      },
    });
    turn.handle({
      type: 'tool_execution_end',
      toolCallId: 'tool-1',
      toolName: 'write',
      result: {
        content: [{ type: 'text', text: 'created with sk-1234567890' }],
        details: { apiKey: 'final-secret' },
      },
      isError: false,
    });
    turn.handle({
      type: 'message_end',
      message: {
        role: 'toolResult',
        toolCallId: 'tool-1',
        toolName: 'write',
        content: [{ type: 'text', text: 'duplicate result' }],
        isError: false,
        timestamp: Date.now(),
      },
    });
    turn.finish(false);
    await turn.flush();

    const toolUpdates = harness.updates.map(({ update }) => update)
      .filter((update) => update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update');
    expect(toolUpdates.map((update) => update.status)).toEqual([
      'pending',
      'in_progress',
      'in_progress',
      'completed',
    ]);
    expect(toolUpdates[0]).toMatchObject({
      toolCallId: 'tool-1',
      title: expect.stringContaining('file.txt'),
      kind: 'edit',
      locations: [{ path }],
      rawInput: { path: 'file.txt', password: '[redacted]' },
    });
    expect(JSON.stringify(toolUpdates)).not.toContain('do-not-send');
    expect(JSON.stringify(toolUpdates)).not.toContain('secret-token');
    expect(JSON.stringify(toolUpdates)).not.toContain('sk-1234567890');
    expect(JSON.stringify(toolUpdates)).not.toContain('partial-secret');
    expect(JSON.stringify(toolUpdates)).not.toContain('final-secret');
    expect(toolUpdates.at(-1)).toMatchObject({
      status: 'completed',
      content: expect.arrayContaining([{
        type: 'diff',
        path,
        oldText: 'before\n',
        newText: 'after\n',
      }]),
      rawOutput: { content: [{ type: 'text', text: 'created with [REDACTED_TOKEN]' }], details: { apiKey: '[redacted]' } },
    });
  });

  it('replays tool calls with stable IDs, typed metadata, and redacted results', async () => {
    const cwd = await temporaryDirectory();
    const manager = SessionManager.inMemory(cwd);
    manager.appendMessage(assistantMessage([{
      type: 'toolCall',
      id: 'read-1',
      name: 'read',
      arguments: { path: 'README.md', token: 'hidden' },
    }], 'toolUse'));
    manager.appendMessage({
      role: 'toolResult',
      toolCallId: 'read-1',
      toolName: 'read',
      content: [{ type: 'text', text: 'Bearer replay-secret' }],
      isError: false,
      timestamp: Date.now(),
    });
    const harness = updateHarness();

    await replayAcpSessionEntries('session-1', cwd, manager.getBranch(), harness.context);

    expect(harness.updates.map(({ update }) => update)).toEqual([
      expect.objectContaining({
        sessionUpdate: 'tool_call',
        toolCallId: 'read-1',
        kind: 'read',
        status: 'pending',
        locations: [{ path: join(cwd, 'README.md') }],
        rawInput: { path: 'README.md', token: '[redacted]' },
      }),
      expect.objectContaining({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'read-1',
        status: 'completed',
      }),
    ]);
    expect(JSON.stringify(harness.updates)).not.toContain('replay-secret');
  });

  it('keeps repeated provider tool IDs unique across ACP prompt turns', async () => {
    const harness = updateHarness();
    const toolCallIds = new AcpToolCallIdRegistry();
    const first = createTurn(harness.context, process.cwd(), 1, toolCallIds);
    const second = createTurn(harness.context, process.cwd(), 2, toolCallIds);

    for (const turn of [first, first, second]) {
      turn.handle({
        type: 'tool_execution_start',
        toolCallId: 'provider-id',
        toolName: 'read',
        args: { path: 'README.md' },
      });
      turn.handle({
        type: 'tool_execution_end',
        toolCallId: 'provider-id',
        toolName: 'read',
        result: { content: [{ type: 'text', text: 'done' }] },
        isError: false,
      });
      turn.finish(false);
      await turn.flush();
    }

    const ids = harness.updates
      .map(({ update }) => update)
      .filter((update) => update.sessionUpdate === 'tool_call')
      .map(({ toolCallId }) => toolCallId);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe('provider-id');
    expect(ids[1]).not.toBe(ids[0]);
    expect(new Set(ids).size).toBe(3);
  });

  it('bounds recursive tool inputs and outputs without leaking secret-like fields', async () => {
    const harness = updateHarness();
    const turn = createTurn(harness.context);
    const oversized = 'x'.repeat(200 * 1024);

    turn.handle({
      type: 'tool_execution_start',
      toolCallId: 'bounded-tool',
      toolName: 'custom_tool',
      args: {
        payload: oversized,
        env: { OPENAI_API_KEY: 'input-secret' },
        self: null,
      },
    });
    turn.handle({
      type: 'tool_execution_end',
      toolCallId: 'bounded-tool',
      toolName: 'custom_tool',
      result: {
        content: [{ type: 'text', text: oversized }],
        details: {
          clientSecret: 'output-secret',
          'set-cookie': 'session=structured-cookie',
          payload: oversized,
        },
      },
      isError: false,
    });
    turn.finish(false);
    await turn.flush();

    const encoded = JSON.stringify(harness.updates);
    expect(Buffer.byteLength(encoded)).toBeLessThan(300 * 1024);
    expect(encoded).toContain('[truncated]');
    expect(encoded).not.toContain('input-secret');
    expect(encoded).not.toContain('output-secret');
    expect(encoded).not.toContain('structured-cookie');
  });

  it('marks failed tools terminal with sanitized error content', async () => {
    const harness = updateHarness();
    const turn = createTurn(harness.context);

    turn.handle({
      type: 'tool_execution_start',
      toolCallId: 'failed-tool',
      toolName: 'bash',
      args: { command: 'exit 1' },
    });
    turn.handle({
      type: 'tool_execution_end',
      toolCallId: 'failed-tool',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'Bearer failure-secret' }] },
      isError: true,
    });
    turn.finish(false);
    await turn.flush();

    const terminal = harness.updates.map(({ update }) => update).at(-1);
    expect(terminal).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'failed-tool',
      status: 'failed',
    });
    expect(JSON.stringify(terminal)).toContain('Bearer [REDACTED_TOKEN]');
    expect(JSON.stringify(terminal)).not.toContain('failure-secret');
  });

  it('omits arbitrary content read from credential-like paths', async () => {
    const harness = updateHarness();
    const turn = createTurn(harness.context, '/workspace');

    turn.handle({
      type: 'tool_execution_start',
      toolCallId: 'secret-read',
      toolName: 'read',
      args: { path: '.npmrc' },
    });
    turn.handle({
      type: 'tool_execution_end',
      toolCallId: 'secret-read',
      toolName: 'read',
      result: { content: [{ type: 'text', text: '_authToken=arbitrary-value-without-a-known-prefix' }] },
      isError: false,
    });
    turn.finish(false);
    await turn.flush();

    const encoded = JSON.stringify(harness.updates);
    expect(encoded).toContain('Sensitive tool output omitted');
    expect(encoded).not.toContain('arbitrary-value-without-a-known-prefix');
  });

  it('sanitizes errors before exposing them to the ACP client', () => {
    const message = sanitizeAcpErrorMessage(
      new Error([
        'request failed with Bearer abc.def',
        'api_key=sk-1234567890',
        'AWS_SECRET_ACCESS_KEY=plain-aws-secret',
        'Set-Cookie: session=plain-cookie',
        '\u0000',
      ].join(' and ')),
    );

    expect(message).toContain('Bearer [REDACTED_TOKEN]');
    expect(message).toContain('api_key=[REDACTED_SECRET]');
    expect(message).not.toContain('abc.def');
    expect(message).not.toContain('sk-1234567890');
    expect(message).not.toContain('plain-aws-secret');
    expect(message).not.toContain('plain-cookie');
    expect(message).not.toContain('\u0000');
  });
});

function createTurn(
  context: AgentContext,
  cwd = process.cwd(),
  turn = 1,
  toolCallIds?: AcpToolCallIdRegistry,
): AcpPromptUpdateStream {
  return new AcpPromptUpdateStream({
    sessionId: 'session-1',
    cwd,
    turn,
    client: context,
    isActive: () => true,
    ...(toolCallIds === undefined ? {} : { toolCallIds }),
  });
}

function updateHarness() {
  const updates: SessionNotification[] = [];
  const context = {
    notify: vi.fn(async (_method: string, params: SessionNotification) => { updates.push(params); }),
  } as unknown as AgentContext;
  return { context, updates };
}

function messageUpdate(
  message: AssistantMessage,
  assistantMessageEvent: Record<string, unknown>,
): AgentSessionEvent {
  return { type: 'message_update', message, assistantMessageEvent } as AgentSessionEvent;
}

function assistantMessage(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'] = 'stop',
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'anthropic-messages',
    provider: 'test',
    model: 'test-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-acp-updates-'));
  temporaryPaths.push(path);
  return path;
}
