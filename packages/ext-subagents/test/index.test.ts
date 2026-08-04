import type {
  ExtensionContext,
  FelanExtensionAPI,
  ToolDefinition,
} from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import {
  createSubagentsExtension,
  type SubagentHost,
  type SubagentRecord,
  type SubagentSpawnRequest,
} from '../src/index.js';

const descriptor = {
  id: 'reviewer',
  description: 'Review changes',
  defaultThinking: 'high' as const,
  defaultMaxTurns: 7,
  allowNesting: false,
};
const policy = {
  maxPromptBytes: 64,
  maxDescriptionBytes: 32,
  maxSteerBytes: 32,
};

describe('@felan-ai/ext-subagents', () => {
  it('registers exactly the canonical tools with a descriptor-derived enum', () => {
    const harness = createHarness();

    expect([...harness.tools.keys()]).toEqual([
      'Agent',
      'list_subagents',
      'get_subagent_result',
      'steer_subagent',
      'cancel_subagent',
    ]);
    const schema = harness.tools.get('Agent')!.parameters as any;
    expect(schema.properties.subagent_type.anyOf).toEqual([
      expect.objectContaining({ const: 'reviewer' }),
    ]);
    expect(schema.properties.thinking.anyOf).toContainEqual(expect.objectContaining({ const: 'max' }));
    expect(Object.keys(schema.properties)).toEqual([
      'prompt',
      'description',
      'subagent_type',
      'model',
      'thinking',
      'max_turns',
      'timeout_seconds',
      'run_in_background',
      'inherit_context',
    ]);
    const resultSchema = harness.tools.get('get_subagent_result')!.parameters as any;
    expect(Object.keys(resultSchema.properties)).toEqual(['agent_id', 'wait', 'timeout_seconds']);
  });

  it('applies shared defaults from the active Pi session', async () => {
    const harness = createHarness();
    const result = await execute(harness, 'Agent', {
      prompt: 'Review',
      description: 'review',
      subagent_type: 'reviewer',
    });

    expect(harness.host.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'reviewer',
        runInBackground: true,
        inheritContext: false,
        model: 'provider/model',
        thinking: 'high',
        maxTurns: 7,
      }),
      undefined,
    );
    expect(resultText(result)).toContain('status: running');
  });

  it('preserves Pi max thinking in the request', async () => {
    const harness = createHarness({ parentThinking: 'max' });
    await execute(harness, 'Agent', {
      prompt: 'Review',
      description: 'review',
      subagent_type: 'reviewer',
      thinking: 'max',
    });

    expect(harness.host.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ thinking: 'max' }),
      undefined,
    );
  });

  it('normalizes validation and host failures without throwing', async () => {
    const harness = createHarness();
    const oversized = await execute(harness, 'Agent', {
      prompt: 'x'.repeat(65),
      description: 'review',
      subagent_type: 'reviewer',
    });
    expect(resultText(oversized)).toContain('invalid_request');
    expect(harness.host.spawn).not.toHaveBeenCalled();

    for (const model of ['auto', 'high', 'preferred-model', '/model', 'provider/']) {
      const invalidModel = await execute(harness, 'Agent', {
        prompt: 'Review',
        description: 'review',
        subagent_type: 'reviewer',
        model,
      });
      expect(resultText(invalidModel)).toContain('unsupported_model');
    }
    expect(harness.host.spawn).not.toHaveBeenCalled();

    (harness.host.cancel as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: { code: 'not_child', message: 'not yours' },
    });
    const denied = await execute(harness, 'cancel_subagent', { agent_id: 'child' });
    expect(resultText(denied)).toBe('Subagent error: not_child — not yours');
  });

  it('accepts inheritance and exact provider/model selectors', async () => {
    const harness = createHarness();

    await execute(harness, 'Agent', {
      prompt: 'Review',
      description: 'review',
      subagent_type: 'reviewer',
      model: 'inherit',
    });
    await execute(harness, 'Agent', {
      prompt: 'Review',
      description: 'review',
      subagent_type: 'reviewer',
      model: 'provider/exact-model',
    });

    expect(harness.host.spawn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ model: 'provider/model' }),
      undefined,
    );
    expect(harness.host.spawn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ model: 'provider/exact-model' }),
      undefined,
    );
  });

  it('maps list, result, steer, and cancel requests to the host', async () => {
    const harness = createHarness();
    await execute(harness, 'list_subagents', { include_descendants: true });
    await execute(harness, 'get_subagent_result', {
      agent_id: 'child', wait: true, timeout_seconds: 2,
    });
    await execute(harness, 'steer_subagent', { agent_id: 'child', message: 'focus' });
    await execute(harness, 'cancel_subagent', { agent_id: 'child', reason: 'stop' });

    expect(harness.host.list).toHaveBeenCalledWith({ includeDescendants: true });
    expect(harness.host.getResult).toHaveBeenCalledWith(
      'child', { wait: true, timeoutSeconds: 2 }, undefined,
    );
    expect(harness.host.steer).toHaveBeenCalledWith('child', 'focus');
    expect(harness.host.cancel).toHaveBeenCalledWith('child', 'stop');
  });

  it('keeps the canonical surface available when no agent types are configured', async () => {
    const harness = createHarness();
    const tools = new Map<string, ToolDefinition<any, any, any>>();
    createSubagentsExtension({
      ...harness.host,
      descriptors: [],
    } as SubagentHost)({
      registerTool: (tool: ToolDefinition<any, any, any>) => tools.set(tool.name, tool),
      getThinkingLevel: () => 'medium',
    } as unknown as FelanExtensionAPI);

    expect([...tools.keys()]).toEqual([...harness.tools.keys()]);
    const result = await tools.get('Agent')!.execute(
      'call',
      { prompt: 'Work', description: 'work', subagent_type: 'general-purpose' },
      undefined,
      undefined,
      { model: { provider: 'provider', id: 'model' } } as ExtensionContext,
    );
    expect(resultText(result)).toContain('unknown_agent_type');
    expect(harness.host.spawn).not.toHaveBeenCalled();
  });
});

function createHarness(options: {
  parentThinking?: 'medium' | 'max';
} = {}) {
  const tools = new Map<string, ToolDefinition<any, any, any>>();
  const record: SubagentRecord = {
    agentId: 'child',
    parentSessionId: 'parent',
    rootSessionId: 'root',
    type: 'reviewer',
    description: 'review',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const host = {
    descriptors: [descriptor],
    policy,
    attachParent: vi.fn(() => () => {}),
    spawn: vi.fn(async (_request: SubagentSpawnRequest) => ({ ok: true as const, value: record })),
    list: vi.fn(async () => ({ ok: true as const, value: [record] })),
    getResult: vi.fn(async () => ({ ok: true as const, value: record })),
    steer: vi.fn(async () => ({ ok: true as const, value: record })),
    cancel: vi.fn(async () => ({ ok: true as const, value: record })),
  };
  const pi = {
    registerTool: (tool: ToolDefinition<any, any, any>) => tools.set(tool.name, tool),
    getThinkingLevel: () => options.parentThinking ?? 'medium',
  } as unknown as FelanExtensionAPI;
  createSubagentsExtension(host)(pi);
  return { pi, tools, host };
}

async function execute(
  harness: ReturnType<typeof createHarness>,
  name: string,
  params: Record<string, unknown>,
) {
  const tool = harness.tools.get(name)!;
  const context = {
    model: { provider: 'provider', id: 'model' },
  } as ExtensionContext;
  return tool.execute('call', params, undefined, undefined, context);
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string | undefined {
  return result.content.find((entry) => entry.type === 'text')?.text;
}
