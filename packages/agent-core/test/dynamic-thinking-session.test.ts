import { describe, expect, it, vi } from 'vitest';
import {
  SessionManager,
  type Api,
  type Classifier,
  type ExtensionAPI,
  type ExtensionContext,
  type Model,
  type SavingsReporter,
} from '../src/index.js';
import { createDynamicThinkingSession } from '../src/dynamic-thinking/session.js';
import { TestAgentRuntime } from './test-agent-runtime.js';

function harness(
  choices: string[], codexEffortUpdatesAvailable = true, reporter?: SavingsReporter,
  initialLevel = 'medium',
) {
  const model = {
    id: 'gpt-6-astra', provider: 'openai-codex', api: 'openai-codex-responses', reasoning: true,
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 10 },
    thinkingLevelMap: { off: 'none', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  } as Model<Api>;
  const manager = SessionManager.inMemory('/workspace');
  const evaluate = vi.fn().mockImplementation(async () => ({
    answers: { effort: { type: 'choice', choice: choices.shift() } },
  }));
  const runtime = Object.assign(new TestAgentRuntime('/workspace'), { classifier: { evaluate } as Classifier });
  const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
  let level = initialLevel;
  const context = { model, sessionManager: manager } as unknown as ExtensionContext;
  const emit = async (name: string, event: unknown) => {
    const payload = name === 'turn_end' ? { toolResults: [], ...(event as object) } : event;
    for (const handler of handlers.get(name) ?? []) await handler(payload, context);
  };
  const setLevel = (next: string) => {
    const previous = level;
    level = next;
    void emit('thinking_level_select', { level: next, previousLevel: previous });
  };
  const pi = {
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    getThinkingLevel: () => level,
    setThinkingLevel: setLevel,
  } as unknown as ExtensionAPI;
  const extension = createDynamicThinkingSession(runtime, codexEffortUpdatesAvailable, reporter);
  if (typeof extension === 'function') extension(pi);
  else extension.factory(pi);
  const assistant = (stopReason = 'stop', usage = { input: 50, output: 1_000, reasoning: 400,
    cacheRead: 0, cacheWrite: 0, cost: { total: 0.08, output: 0.05 } }) => ({
    role: 'assistant', stopReason, provider: model.provider, api: model.api, model: model.id, usage,
  });
  const settle = (outcome: 'completed' | 'error' | 'aborted' = 'completed') => emit('agent_before_settle', {
    outcome, continue: false, context: { pendingMessages: [] },
  });
  return { manager, emit, evaluate, getLevel: () => level, setLevel, assistant, settle };
}

describe('dynamic thinking session lifecycle', () => {
  it('skips Codex decisions without the reasoning-update extension', async () => {
    const { emit, evaluate, getLevel } = harness(['low'], false);
    await emit('before_agent_start', { prompt: 'Summarize the file' });
    expect(evaluate).not.toHaveBeenCalled();
    expect(getLevel()).toBe('medium');
  });

  it('classifies only at agent start, not queued messages or tool continuations', async () => {
    const { manager, emit, evaluate, getLevel } = harness(['low', 'high']);
    await emit('before_agent_start', { prompt: 'Simple edit' });
    expect(getLevel()).toBe('low');
    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Simple edit' }], timestamp: 1 });
    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Now debug the race' }], timestamp: 2 });
    await emit('turn_start', { turnIndex: 1 });
    expect(getLevel()).toBe('low');
    expect(evaluate).toHaveBeenCalledOnce();
    await emit('before_agent_start', { prompt: 'New independent request' });
    expect(getLevel()).toBe('high');
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('keeps an explicit thinking selection authoritative for subsequent turns', async () => {
    const { emit, evaluate, getLevel, setLevel } = harness(['low']);
    setLevel('max');
    await emit('before_agent_start', { prompt: 'Do something' });
    expect(getLevel()).toBe('max');
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('does not apply a result after shutdown', async () => {
    const { emit, evaluate, getLevel } = harness(['high']);
    let release!: (value: unknown) => void;
    evaluate.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = emit('before_agent_start', { prompt: 'Fresh request' });
    await emit('session_shutdown', {});
    release({ answers: { effort: { type: 'choice', choice: 'high' } } });
    await pending;
    expect(getLevel()).toBe('medium');
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it('reports only the first successful high-to-medium Astra response, net of classifier cost', async () => {
    const report = vi.fn().mockResolvedValue(undefined);
    const { emit, evaluate, assistant } = harness(['medium'], true, { report }, 'high');
    evaluate.mockResolvedValueOnce({
      answers: { effort: { type: 'choice', choice: 'medium' } },
      metadata: { usage: { requests: 1, costUsd: 0.0002 } },
    });
    await emit('before_agent_start', { prompt: 'Fix the bug' });
    await emit('turn_end', { message: assistant() });
    await emit('turn_end', { message: assistant() });
    expect(report).not.toHaveBeenCalled();
    await emit('agent_before_settle', { outcome: 'completed', continue: false, context: { pendingMessages: [] } });
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith({
      category: 'output-optimization', operation: 'dynamic-thinking',
      baseline: {
        model: { provider: 'openai-codex', id: 'gpt-6-astra' },
        tokens: { input: 50, output: 1_020, cacheRead: 0, cacheWrite: 0 },
        costUsd: expect.any(Number),
      },
      actual: {
        model: { provider: 'openai-codex', id: 'gpt-6-astra' },
        tokens: { input: 50, output: 1_000, cacheRead: 0, cacheWrite: 0 },
        costUsd: expect.any(Number),
      },
      basis: { kind: 'estimated-baseline', method: 'high-effort-reasoning-5pct-heuristic-v1' },
    });
    expect(report.mock.calls[0]?.[0].baseline.costUsd).toBeCloseTo(0.081);
    expect(report.mock.calls[0]?.[0].actual.costUsd).toBeCloseTo(0.0802);
  });

  it('does not report unchanged, upshifted, failed, or invalid responses', async () => {
    const report = vi.fn().mockResolvedValue(undefined);
    const noChange = harness(['high'], true, { report }, 'high');
    await noChange.emit('before_agent_start', { prompt: 'No-op' });
    await noChange.emit('turn_end', { message: noChange.assistant() });
    await noChange.settle();

    const unsupported = harness(['low'], true, { report });
    await unsupported.emit('before_agent_start', { prompt: 'Not high to low' });
    await unsupported.emit('turn_end', { message: unsupported.assistant() });
    await unsupported.settle();

    const returned = harness(['high'], true, { report });
    await returned.emit('before_agent_start', { prompt: 'Back to high' });
    await returned.emit('turn_end', { message: returned.assistant() });
    await returned.settle();

    const failed = harness(['medium'], true, { report }, 'high');
    await failed.emit('before_agent_start', { prompt: 'Failed response' });
    await failed.emit('turn_end', { message: failed.assistant('error') });
    await failed.settle('error');

    const invalid = harness(['medium'], true, { report }, 'high');
    await invalid.emit('before_agent_start', { prompt: 'Invalid reasoning' });
    await invalid.emit('turn_end', { message: invalid.assistant('stop', {
      input: 50, output: 1_000, reasoning: 1_001, cacheRead: 0, cacheWrite: 0,
      cost: { total: 0.08, output: 0.05 },
    }) });
    await invalid.settle();
    expect(report).not.toHaveBeenCalled();
  });

  it('invalidates a pending measurement after a manual override, aborted turn or model mismatch', async () => {
    const report = vi.fn().mockResolvedValue(undefined);
    const manual = harness(['medium'], true, { report }, 'high');
    await manual.emit('before_agent_start', { prompt: 'Short task' });
    manual.setLevel('low');
    await manual.emit('turn_end', { message: manual.assistant() });
    await manual.settle();

    const aborted = harness(['medium'], true, { report }, 'high');
    await aborted.emit('before_agent_start', { prompt: 'Interrupted task' });
    await aborted.emit('turn_end', { message: aborted.assistant('aborted') });
    await aborted.settle('aborted');

    const switched = harness(['medium'], true, { report }, 'high');
    await switched.emit('before_agent_start', { prompt: 'Switch models' });
    await switched.emit('turn_end', { message: { ...switched.assistant(), model: 'gpt-6-sol' } });
    await switched.emit('turn_end', { message: switched.assistant() });
    await switched.settle();
    expect(report).not.toHaveBeenCalled();
  });

  it('skips a downgrade whose classifier cost exceeds estimated output savings', async () => {
    const report = vi.fn().mockResolvedValue(undefined);
    const { emit, evaluate, assistant, settle } = harness(['medium'], true, { report }, 'high');
    evaluate.mockResolvedValueOnce({
      answers: { effort: { type: 'choice', choice: 'medium' } },
      metadata: { usage: { requests: 1, costUsd: 0.002 } },
    });
    await emit('before_agent_start', { prompt: 'Simple task' });
    await emit('turn_end', { message: assistant() });
    await settle();
    expect(report).not.toHaveBeenCalled();
  });

  it('does not let savings storage failures affect the assistant turn', async () => {
    const report = vi.fn().mockRejectedValue(new Error('Storage unavailable'));
    const { emit, assistant } = harness(['low'], true, { report }, 'high');
    await emit('before_agent_start', { prompt: 'Simple task' });
    await emit('turn_end', { message: assistant() });
    await expect(emit('agent_before_settle', {
      outcome: 'completed', continue: false, context: { pendingMessages: [] },
    })).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledOnce();
  });

  it('skips a failed tool or a later aborted continuation instead of reporting prematurely', async () => {
    const report = vi.fn().mockResolvedValue(undefined);
    const failedTool = harness(['medium'], true, { report }, 'high');
    await failedTool.emit('before_agent_start', { prompt: 'Fix with a tool' });
    await failedTool.emit('turn_end', {
      message: failedTool.assistant('toolUse'), toolResults: [{ isError: true }],
    });
    await failedTool.emit('agent_before_settle', {
      outcome: 'completed', continue: false, context: { pendingMessages: [] },
    });

    const aborted = harness(['medium'], true, { report }, 'high');
    await aborted.emit('before_agent_start', { prompt: 'Fix with a tool' });
    await aborted.emit('turn_end', {
      message: aborted.assistant('toolUse'), toolResults: [{ isError: false }],
    });
    await aborted.emit('agent_before_settle', {
      outcome: 'aborted', continue: false, context: { pendingMessages: [] },
    });
    expect(report).not.toHaveBeenCalled();
  });

  it('waits for a successful completed run and counts only its first assistant response', async () => {
    const report = vi.fn().mockResolvedValue(undefined);
    const { emit, assistant } = harness(['low'], true, { report }, 'high');
    await emit('before_agent_start', { prompt: 'Use a tool' });
    await emit('turn_end', { message: assistant('toolUse'), toolResults: [{ isError: false }] });
    await emit('turn_end', { message: assistant(), toolResults: [] });
    await emit('agent_before_settle', {
      outcome: 'completed', continue: true, context: { pendingMessages: [] },
    });
    expect(report).not.toHaveBeenCalled();
    await emit('agent_before_settle', {
      outcome: 'completed', continue: false, context: { pendingMessages: [] },
    });
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]?.[0].actual.tokens.output).toBe(1_000);
  });
});
