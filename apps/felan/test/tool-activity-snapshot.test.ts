import { expect, it, vi } from 'vitest';
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { ToolActivityState } from '../src/tool-activity/state.js';

type Message = AgentSession['messages'][number];
type Assistant = Extract<Message, { role: 'assistant' }>;
const assistant = (timestamp: number, content: Assistant['content'], stopReason: Assistant['stopReason'] = 'toolUse'): Assistant => ({
  role: 'assistant', timestamp, content, stopReason, api: 'openai-completions', provider: 'fixture', model: 'fixture',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const call = (id: string, name = 'probe', args: Record<string, unknown> = {}): Assistant['content'][number] => ({ type: 'toolCall', id, name, arguments: args });
const result = (id: string, toolName = 'probe', isError = false, text = `${id} result`): Extract<Message, { role: 'toolResult' }> => ({
  role: 'toolResult', timestamp: 100, toolCallId: id, toolName, isError, content: [{ type: 'text', text }],
});

it.each(['grouped', 'full'] as const)('extends %s snapshots with stable calls, groups and renderer invalidation', mode => {
  const state = new ToolActivityState(mode); const fresh = new ToolActivityState(mode);
  let messages: Message[] = [assistant(1, [call('one')])];
  const live = (streaming?: Assistant, pending: string[] = []) => ({ pendingToolCalls: new Set(pending), ...(streaming ? { streaming } : {}) });
  state.showSnapshot(messages, '/fixture', live(assistant(2, [{ type: 'text', text: 'Transient boundary' }]), ['one']));
  const first = state.call('one'); const invalidator = vi.fn(); state.registerRenderer('one', invalidator);
  const check = (appended: Message[], next = live()) => {
    const previous = new Map(state.calls().map(item => [item.id, item]));
    messages = [...messages, ...appended]; expect(state.extendSnapshot(appended, next)).toBe(true); fresh.showSnapshot(messages, '/fixture', next);
    expect(state.calls()).toEqual(fresh.calls()); expect(state.groups()).toEqual(fresh.groups());
    for (const item of state.calls()) {
      expect(state.placement(item.id)).toEqual(fresh.placement(item.id));
      if (previous.has(item.id)) expect(item).toBe(previous.get(item.id));
    }
  };
  try {
    check([], live()); check([], live(undefined, ['one']));
    check([result('one'), assistant(2, [call('two')])], live(undefined, ['two']));
    expect(state.call('one')).toBe(first); expect(state.groups()[0]).toEqual({ id: 'one', callIds: ['one', 'two'], standalone: false });
    expect(invalidator).toHaveBeenCalled();
    check([], live(assistant(3, [{ type: 'thinking', thinking: 'Visible boundary' }]), ['two']));
    check([result('two', 'probe', true), assistant(3, [call('ask', 'ask_user'), call('image', 'view_image')])]);
    check([assistant(4, [call('bad')], 'aborted'), assistant(5, [call('error')], 'error')]);
    check([{ role: 'user', content: 'New boundary', timestamp: 6 }, assistant(7, [call('bash', 'bash', { command: 'sleep 10' })])]);
    check([result('bash', 'bash', false, 'background'), assistant(8, [call('read', 'read_background_bash', { id: 'job' })])]);
    check([{ ...result('read', 'read_background_bash'), details: { job: { meta: { id: 'job', command: 'sleep 10' } } } }, assistant(9, [call('wait', 'wait_background_bash', { id: 'job' })])]);
    expect(state.call('wait')?.relatedCommand).toBe('sleep 10');
    check([{ ...result('wait', 'wait_background_bash'), content: [{ type: 'image', data: 'eA==', mimeType: 'image/png' }] }]);
    check([], live(assistant(10, []))); check([], live(assistant(10, [{ type: 'text', text: 'Growing stream' }]))); check([]);
  } finally { state.dispose(); fresh.dispose(); }
});

it.each(['grouped', 'full'] as const)('replaces shell boundaries and streaming segments like a fresh %s snapshot', mode => {
  const state = new ToolActivityState(mode); const fresh = new ToolActivityState(mode);
  const shell: Message = { role: 'bashExecution', command: 'echo live', output: 'partial', timestamp: 2, cancelled: false, truncated: false };
  let messages: Message[] = [assistant(1, [call('one')]), result('one')];
  const check = (appended: Message[], shells: Message[], streaming?: Assistant) => {
    messages = [...messages, ...appended];
    const live = { pendingToolCalls: new Set<string>(), trailingMessages: shells, ...(streaming ? { streaming } : {}) };
    expect(state.extendSnapshot(appended, live)).toBe(true);
    fresh.showSnapshot([...messages, ...shells], '/fixture', { pendingToolCalls: live.pendingToolCalls, ...(streaming ? { streaming } : {}) });
    expect(state.calls()).toEqual(fresh.calls()); expect(state.groups()).toEqual(fresh.groups());
    for (const item of state.calls()) expect(state.placement(item.id)).toEqual(fresh.placement(item.id));
  };
  try {
    state.showSnapshot(messages, '/fixture', { pendingToolCalls: new Set(), trailingMessages: [shell] });
    check([], [{ ...shell, output: 'more' }], assistant(3, [{ type: 'text', text: 'Draft' }]));
    check([assistant(2, [call('two')]), result('two')], [shell], assistant(3, []));
    expect(state.groups()[0]?.callIds).toEqual(['one', 'two']);
    check([shell, assistant(3, [call('three')]), result('three')], []);
    expect(state.groups().map(group => group.callIds)).toEqual([['one', 'two'], ['three']]);
  } finally { state.dispose(); fresh.dispose(); }
});

it.each(['calls', 'not last'] as const)('rejects unsafe active snapshot segments with %s without mutating state', reason => {
  const state = new ToolActivityState('grouped');
  let notify: ((event: AgentSessionEvent) => void) | undefined;
  const session = {
    sessionManager: { getBranch: () => [], buildContextEntries: () => [] },
    state: { pendingToolCalls: [] },
    subscribe: (callback: (event: AgentSessionEvent) => void) => { notify = callback; return () => {}; },
  } as unknown as AgentSession;
  try {
    state.attach(session);
    state.showSnapshot([assistant(1, [call('history')])], '/fixture', {
      pendingToolCalls: new Set(['history']), streaming: assistant(2, reason === 'calls' ? [call('stream')] : []),
    });
    if (reason === 'not last') notify!({ type: 'entry_appended', entry: { type: 'custom' } } as AgentSessionEvent);
    const calls = structuredClone(state.calls()); const groups = structuredClone(state.groups());
    expect(state.extendSnapshot([assistant(3, [call('new')])], { pendingToolCalls: new Set() })).toBe(false);
    expect(state.calls()).toEqual(calls); expect(state.groups()).toEqual(groups); expect(state.call('new')).toBeUndefined();
  } finally { state.dispose(); }
});

it.each(['grouped', 'full'] as const)('marks unresolved calls as errors in a %s snapshot without live state', mode => {
  const state = new ToolActivityState(mode);
  try {
    state.showSnapshot([assistant(1, [call('pending'), call('completed')]), result('completed')], '/fixture');
    expect(state.call('pending')).toMatchObject({ status: 'error', isError: true, isPartial: false, completedAt: 1,
      result: { content: [{ type: 'text', text: 'No retained tool result.' }] } });
    expect(state.call('completed')).toMatchObject({ status: 'completed', isError: false, isPartial: false,
      result: { content: [{ type: 'text', text: 'completed result' }] } });
  } finally { state.dispose(); }
});

it.each(['fresh', 'attached'] as const)('rejects extending a %s state without mutating calls or subscriptions', kind => {
  const state = new ToolActivityState('grouped'); const unsubscribe = vi.fn();
  let notify: ((event: AgentSessionEvent) => void) | undefined;
  try {
    if (kind === 'attached') {
      state.attach({
        sessionManager: { getBranch: () => [], buildContextEntries: () => [] }, state: { pendingToolCalls: [] },
        subscribe: (callback: (event: AgentSessionEvent) => void) => { notify = callback; return unsubscribe; },
      } as unknown as AgentSession);
      notify!({ type: 'message_start', message: assistant(1, [call('existing')]) });
    }
    const calls = structuredClone(state.calls()); const groups = structuredClone(state.groups());
    expect(state.extendSnapshot([assistant(2, [call('new')])], { pendingToolCalls: new Set() })).toBe(false);
    expect(state.calls()).toEqual(calls); expect(state.groups()).toEqual(groups); expect(state.call('new')).toBeUndefined();
    expect(unsubscribe).not.toHaveBeenCalled();
    state.dispose(); expect(unsubscribe).toHaveBeenCalledTimes(kind === 'attached' ? 1 : 0);
  } finally { state.dispose(); }
});
