import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HostAgentRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentCoreSession,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type StreamFunction,
  type TranscriptContext,
} from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSubagentsExtension, type SubagentHost } from '../src/index.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('Pi subagent-routing integration', () => {
  it('persists one authoritative system-prompt decision across a tool turn without a custom message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'felan-subagent-routing-'));
    temporaryPaths.push(root);
    const cwd = join(root, 'workspace');
    const agentDir = join(root, 'agent');
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null });
    const model = modelRuntime.getModel('openai-codex', 'gpt-5.6-luna');
    if (!model) throw new Error('Expected built-in test model');
    vi.spyOn(modelRuntime, 'hasConfiguredAuth').mockReturnValue(true);
    vi.spyOn(modelRuntime, 'checkAuth').mockResolvedValue({} as never);
    const contexts: TranscriptContext[] = [];
    let request = 0;
    const stream: StreamFunction = (activeModel, context) => {
      contexts.push(context);
      request += 1;
      return assistantStream(request === 1
        ? {
            ...assistantMessage(activeModel, 'toolUse'),
            content: [{ type: 'toolCall', id: 'list-1', name: 'list_subagents', arguments: {} }],
          }
        : assistantMessage(activeModel, 'stop'));
    };
    const sessionManager = SessionManager.inMemory(cwd);
    const runtime = new HostAgentRuntime(cwd, {
      sessionStorageRoot: join(root, 'session-storage'),
      agentStorageRoot: join(root, 'agent-storage'),
      agentDir,
      classifier: {
        evaluate: async () => ({ answers: {} }),
        evaluateProbabilities: async (_state, questions) => ({
          answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { probability: 0.9 }])),
        }),
      },
    });
    const host = {
      descriptors: [{ id: 'explore', description: 'Read-only investigation', allowNesting: false }],
      policy: { maxPromptBytes: 10_000, maxDescriptionBytes: 1_000, maxSteerBytes: 1_000 },
      attachParent: vi.fn(() => () => {}),
      spawn: vi.fn(),
      list: vi.fn(async () => ({ ok: true as const, value: [] })),
      getResult: vi.fn(),
      steer: vi.fn(),
      cancel: vi.fn(),
    } as unknown as SubagentHost;
    const result = await createAgentCoreSession({
      runtime,
      extensionPackages: ['@felan-ai/ext-subagents'],
      importExtension: async () => ({ default: createSubagentsExtension(host) }),
      modelRuntime,
      settingsManager: SettingsManager.inMemory(),
      sessionManager,
      agentDir,
      model,
      wrapStreamFunction: () => stream,
    });

    await result.session.bindExtensions({ mode: 'print' });
    await result.session.prompt('Inspect the parser');

    expect(contexts).toHaveLength(2);
    for (const context of contexts) {
      const userText = context.messages
        .filter((message) => message.role === 'user')
        .map((message) => textContent(message.content));
      expect(userText).toEqual(['Inspect the parser']);
      const routingSection = context.messages
        .find((message) => message.role === 'system')
        ?.sections?.subagent_routing;
      expect(routingSection).toMatch(/Subagent routing decision.*execution decision.*explore \(Read-only investigation\)/s);
    }
    const entries = sessionManager.getEntries();
    const routingEntries = entries.filter((entry) => (
      entry.type === 'custom_message' && entry.customType === 'felan-subagent-routing'
    ));
    expect(routingEntries).toHaveLength(0);
    const routingSystemEntries = entries.filter((entry) => (
      entry.type === 'message'
      && entry.message.role === 'system'
      && entry.message.sections?.subagent_routing !== undefined
    ));
    expect(routingSystemEntries).toHaveLength(1);
    expect(routingSystemEntries[0]).toMatchObject({
      type: 'message',
      message: {
        role: 'system',
        sections: {
          subagent_routing: expect.stringMatching(/Subagent routing decision.*explore \(Read-only investigation\)/s),
        },
      },
    });
    expect(sessionManager.buildContextEntries()).not.toContainEqual(expect.objectContaining({
      type: 'custom_message',
      customType: 'felan-subagent-routing',
    }));

    result.session.dispose();
  });
});

function assistantMessage(
  model: Parameters<StreamFunction>[0],
  stopReason: AssistantMessage['stopReason'],
): AssistantMessage {
  return {
    role: 'assistant',
    content: stopReason === 'stop' ? [{ type: 'text', text: 'Done' }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
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

function assistantStream(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({
      type: 'start',
      partial: { ...message, content: [], stopReason: 'pending' },
    });
    stream.push({
      type: 'done',
      reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop',
      message,
    });
  });
  return stream;
}

function textContent(content: string | readonly { type: string; text?: string }[]): string {
  return typeof content === 'string'
    ? content
    : content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join('\n');
}
