import {
  SESSIONS_SERVICE,
  getExtensionConfigDefinition,
  type ExtensionContext,
  type ExtensionUi,
  type FelanExtensionAPI,
  type ToolDefinition,
  type UiRequestResult,
} from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import prewalkExtension, { PREWALK_CONFIG } from '../src/extension.js';

afterEach(() => { vi.restoreAllMocks(); });

const answer = (actionId: string, values = {}, outcome: 'submit' | 'cancel' = 'submit'): UiRequestResult => ({
  state: 'answered', answer: { kind: 'form', actionId, outcome, values },
});

describe('common-UI Prewalk root', () => {
  it('needs no feature service, reads only the optional session identity and preserves configuration metadata', async () => {
    expect(prewalkExtension.serviceRequirements).toEqual({ optional: [SESSIONS_SERVICE] });
    expect(getExtensionConfigDefinition(prewalkExtension)).toBe(PREWALK_CONFIG);
    const h = harness();
    expect([...h.tools.keys()]).toEqual(['enter_prewalk', 'exit_plan_mode']);
    expect(h.getService.mock.calls).toEqual([[SESSIONS_SERVICE]]);
    await h.shutdown();
  });

  it('withholds Prewalk from a subagent session without requesting UI', async () => {
    const h = harness(undefined, {}, { id: 'child', root: 'root', parent: 'root' });
    await h.start();
    expect(h.setActiveTools).toHaveBeenCalledExactlyOnceWith(['read', 'write']);
    await expect(h.execute('enter_prewalk', {})).rejects.toThrow('not in subagents');
    expect(h.request).not.toHaveBeenCalled();
    await h.shutdown();
  });

  it('does not bypass entry approval when common input is unavailable', async () => {
    const request = vi.fn<ExtensionUi['request']>().mockResolvedValue({ state: 'cancelled', reason: 'unsupported' });
    const h = harness(request, { entryApproval: 'ask' });
    Object.assign(h.context, { hasUI: false, mode: 'print' });
    await expect(h.execute('enter_prewalk', {})).rejects.toThrow('Prewalk entry was not approved');
    expect(request.mock.calls[0]?.[0]).toMatchObject({ title: 'Enter Prewalk?', input: { fields: [] } });
    expect(h.setModel).not.toHaveBeenCalled();
    expect(h.setThinkingLevel).not.toHaveBeenCalled();
    await h.shutdown();
  });

  it('accepts explicit common-UI entry approval independently of Pi mode', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const request = vi.fn<ExtensionUi['request']>().mockResolvedValue(answer('enter'));
    const h = harness(request, { entryApproval: 'ask' });
    Object.assign(h.context, { hasUI: false, mode: 'print' });
    expect(await h.execute('enter_prewalk', {})).toMatchObject({ details: { phase: 'planning' } });
    expect(h.select).not.toHaveBeenCalled();
    await h.shutdown();
  });

  it('preserves deny policy without requesting UI', async () => {
    const h = harness(undefined, { entryApproval: 'deny' });
    await expect(h.execute('enter_prewalk', {})).rejects.toThrow('disabled');
    expect(h.request).not.toHaveBeenCalled();
    await h.shutdown();
  });

  it('sends the full plan and explicit actions, without a required hint or legacy dialog', async () => {
    const h = harness();
    expect(await h.execute('enter_prewalk', {})).toMatchObject({ details: { phase: 'planning', targetThinking: 'medium' } });
    const plan = '# Plan\n\nInspect, implement, verify.\n\n' + 'Full details. '.repeat(1000);
    expect(await h.execute('exit_plan_mode', { plan })).toMatchObject({ details: { phase: 'planning', decision: 'approved' } });
    expect(h.request.mock.calls[0]?.[0]).toMatchObject({
      title: 'Review Prewalk plan', markdown: plan,
      input: { fields: [{ id: 'feedback', required: false, multiline: true, maxLength: 16 * 1024 }] },
      actions: [
        { id: 'approve', outcome: 'submit', target: 'element' },
        { id: 'feedback', outcome: 'submit', target: 'element' },
        { id: 'cancel', outcome: 'cancel', target: 'element' },
      ],
    });
    expect(h.request.mock.calls[0]?.[0].hint).toEqual({ id: 'prewalk.plan-review', version: '1' });
    expect(h.select).not.toHaveBeenCalled();
    expect(h.setModel).not.toHaveBeenCalled();
    await h.shutdown();
    expect(h.setThinkingLevel).toHaveBeenCalledWith('high', { updateDefault: false });
  });

  it('preserves feedback before approval and prevents duplicate approval', async () => {
    const request = vi.fn<ExtensionUi['request']>()
      .mockResolvedValueOnce(answer('feedback', { feedback: 'Add a recovery test.' }))
      .mockResolvedValueOnce(answer('approve'));
    const h = harness(request);
    await h.execute('enter_prewalk', {});
    expect(await h.execute('exit_plan_mode', { plan: 'First plan' }))
      .toMatchObject({ details: { phase: 'planning', decision: 'feedback', feedback: 'Add a recovery test.' } });
    expect(await h.execute('exit_plan_mode', { plan: 'Plan with recovery test' }))
      .toMatchObject({ details: { phase: 'planning', decision: 'approved' } });
    await expect(h.execute('exit_plan_mode', { plan: 'Do not review twice' })).rejects.toThrow('already approved');
    expect(request).toHaveBeenCalledTimes(2);
    await h.shutdown();
  });

  it('cancels only on the explicit cancel action', async () => {
    const h = harness(vi.fn<ExtensionUi['request']>().mockResolvedValue(answer('cancel', {}, 'cancel')));
    await h.execute('enter_prewalk', {});
    expect(await h.execute('exit_plan_mode', { plan: 'Plan' }))
      .toMatchObject({ terminate: true, details: { phase: 'idle', decision: 'cancelled' } });
    await h.shutdown();
  });

  it.each([
    { state: 'deferred', interactionId: 'pending' },
    { state: 'cancelled', reason: 'unsupported' },
    { state: 'cancelled', reason: 'user' },
    answer('approve', {}, 'cancel'),
    answer('feedback', { feedback: '  ' }),
  ] satisfies UiRequestResult[])('does not approve a non-approval result: %j', async result => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness(vi.fn<ExtensionUi['request']>().mockResolvedValue(result));
    Object.assign(h.context, { hasUI: false, mode: 'print' });
    await h.execute('enter_prewalk', {});
    expect(await h.execute('exit_plan_mode', { plan: 'Plan' }))
      .toMatchObject({ details: { phase: 'planning', decision: 'dismissed' } });
    expect(h.setModel).not.toHaveBeenCalled();
    await h.shutdown();
  });

  it('escapes untrusted Markdown constructs and refuses byte overflow without truncation', async () => {
    const h = harness(vi.fn<ExtensionUi['request']>().mockResolvedValue({ state: 'cancelled', reason: 'user' }));
    await h.execute('enter_prewalk', {});
    await h.execute('exit_plan_mode', { plan: '<script>x</script> [file](file:///secret)\n[x]: javascript:alert(1)\u001b' });
    const markdown = h.request.mock.calls[0]?.[0].markdown!;
    expect(markdown).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(markdown).toContain('&#91;file&#93;(file:///secret)');
    expect(markdown).toContain('&#91;x&#93;: javascript:alert(1)');
    expect(markdown).toContain('\\u001b');
    expect(markdown).not.toMatch(/<\/?[a-z]|\]\(/iu);
    const overflowingPlan = '['.repeat(32_000);
    expect(new TextEncoder().encode('&#91;'.repeat(32_000)).length).toBeGreaterThan(128 * 1024);
    await expect(h.execute('exit_plan_mode', { plan: overflowingPlan })).rejects.toThrow('byte limit');
    expect(h.request).toHaveBeenCalledOnce();
    await expect(h.execute('exit_plan_mode', { plan: 'x'.repeat(32_001) })).rejects.toThrow('32000');
    await h.shutdown();
  });

  it('preserves complete multibyte plans within the byte budget and rejects one byte over the boundary', async () => {
    const h = harness(vi.fn<ExtensionUi['request']>().mockResolvedValue({ state: 'cancelled', reason: 'user' }));
    await h.execute('enter_prewalk', {});
    const multibytePlan = '[界'.repeat(16_000);
    expect(await h.execute('exit_plan_mode', { plan: multibytePlan }))
      .toMatchObject({ details: { phase: 'planning', decision: 'dismissed' } });
    expect(h.request.mock.calls[0]?.[0].markdown).toBe('&#91;界'.repeat(16_000));
    expect(new TextEncoder().encode(h.request.mock.calls[0]![0].markdown!).length).toBe(128_000);

    const boundaryPlan = '['.repeat(26_214) + 'ab';
    await h.execute('exit_plan_mode', { plan: boundaryPlan });
    expect(h.request.mock.calls[1]?.[0].markdown).toBe('&#91;'.repeat(26_214) + 'ab');
    expect(new TextEncoder().encode(h.request.mock.calls[1]![0].markdown!).length).toBe(128 * 1024);
    await expect(h.execute('exit_plan_mode', { plan: boundaryPlan + 'c' })).rejects.toThrow('byte limit');
    expect(h.request).toHaveBeenCalledTimes(2);
    await h.shutdown();
  });

  it.each(['json', 'print'] as const)('requires explicit common-UI plan approval in %s mode', async mode => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness();
    Object.assign(h.context, { mode, hasUI: false });
    await h.execute('enter_prewalk', {});
    expect(await h.execute('exit_plan_mode', { plan: 'Explicitly reviewed plan' }))
      .toMatchObject({ details: { phase: 'planning', decision: 'approved' } });
    expect(h.request).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalledWith(`Prewalk auto-approved plan review because interactive input is unavailable in ${mode} mode.`);
    await h.shutdown();
  });

  it('aborts pending review on shutdown, drains it, and rejects late approval', async () => {
    let finish!: (result: UiRequestResult) => void;
    const request = vi.fn<ExtensionUi['request']>(() => new Promise(resolve => { finish = resolve; }));
    const h = harness(request);
    await h.execute('enter_prewalk', {});
    const work = h.execute('exit_plan_mode', { plan: 'Plan' });
    const outcome = expect(work).rejects.toMatchObject({ name: 'AbortError' });
    let stopped = false;
    const shutdown = h.shutdown().then(() => { stopped = true; });
    try {
      expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      await Promise.resolve();
      expect(stopped).toBe(false);
    } finally {
      finish(answer('approve'));
      await outcome;
      await shutdown;
    }
    expect(h.setModel).not.toHaveBeenCalled();
  });

  it('forwards a tool abort signal and leaves the plan unapproved', async () => {
    let finish!: (result: UiRequestResult) => void;
    const request = vi.fn<ExtensionUi['request']>(() => new Promise(resolve => { finish = resolve; }));
    const h = harness(request);
    await h.execute('enter_prewalk', {});
    const controller = new AbortController();
    const work = h.execute('exit_plan_mode', { plan: 'Plan' }, controller.signal);
    controller.abort();
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    finish(answer('approve'));
    await expect(work).rejects.toMatchObject({ name: 'AbortError' });
    await h.shutdown();
  });
});

function harness(request = vi.fn<ExtensionUi['request']>().mockResolvedValue(answer('approve')), config: Record<string, unknown> = {},
  current: { id: string; root: string; parent?: string } = { id: 'root', root: 'root' }) {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const model = { provider: 'test', id: 'model-pro', name: 'Planner', reasoning: true };
  const select = vi.fn();
  const setModel = vi.fn().mockResolvedValue(true);
  const setThinkingLevel = vi.fn();
  const getService = vi.fn((contract: unknown) => {
    if (contract === SESSIONS_SERVICE) return { current };
    throw new Error('Feature UI service must not be read');
  });
  const setActiveTools = vi.fn();
  const context = {
    model, mode: 'tui', hasUI: true, scopedModels: [],
    modelRegistry: { getAvailable: () => [model], hasConfiguredAuth: () => true },
    sessionManager: { getSessionId: () => 'root', getHeader: () => ({}) },
    ui: { select, setStatus: vi.fn(), notify: vi.fn() }, isIdle: () => true,
    tools: [], executeTool: vi.fn(async () => { throw new Error('Unexpected nested tool execution'); }),
  } as unknown as Parameters<ToolDefinition['execute']>[4];
  prewalkExtension({
    config: { targetModel: 'low', targetThinking: 'medium', restorePlanner: true, entryApproval: 'allow', planReview: 'ask', ...config },
    services: { get: getService },
    ui: { request, notify: vi.fn(), status: vi.fn(), removeStatus: vi.fn(), present: vi.fn() },
    runtime: {}, getThinkingLevel: () => 'high', getActiveTools: () => ['read', 'write', 'enter_prewalk', 'exit_plan_mode'], setActiveTools,
    setThinkingLevel, setModel, registerCapability: vi.fn(), registerCommand: vi.fn(),
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
  } as unknown as FelanExtensionAPI);
  return {
    tools, context, select, request, getService, setModel, setThinkingLevel, setActiveTools,
    start: async () => { for (const handler of handlers.get('session_start') ?? []) await handler({ type: 'session_start', reason: 'startup' }, context); },
    execute: (name: string, args: unknown, signal?: AbortSignal) => tools.get(name)!.execute('call', args, signal, undefined, context),
    shutdown: async () => { for (const handler of handlers.get('session_shutdown') ?? []) await handler({}, context); },
  };
}
