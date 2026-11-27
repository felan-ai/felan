import { describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@felan-ai/agent-core';
import { installStepHold, parseContinueRecord, type ParkedStep } from '../src/daemon/run-hold.js';

type Agent = AgentSession['agent'];
type Turn = Parameters<NonNullable<Agent['finishTurn']>>[0];

/** A session with only the agent hooks the wrapper touches; `previous` stands for Pi's own step-end hook. */
function session(previous?: Agent['finishTurn']) {
  const agent = { finishTurn: previous, afterToolCall: undefined } as unknown as Agent;
  const value = { agent, sessionManager: { getLeafId: () => 'leaf' }, resourceLoader: {} } as unknown as AgentSession;
  return value;
}
function turn(calls: string[], stopReason: 'toolUse' | 'stop' | 'error' | 'aborted' = calls.length ? 'toolUse' : 'stop'): Turn {
  return { message: { role: 'assistant', stopReason, content: calls.map(id => ({ type: 'toolCall', id, name: 'tool', arguments: {} })) },
    toolResults: calls.map(id => ({ role: 'toolResult', toolCallId: id, toolName: 'tool', content: [], isError: false, timestamp: 0 })), context: {}, newMessages: [] } as unknown as Turn;
}
function hooks(active: boolean) {
  const parked: ParkedStep[] = [];
  return { parked, value: { active: vi.fn(() => active), parked: vi.fn((step: ParkedStep) => { parked.push(step); }), released: vi.fn() } };
}

describe('step hold', () => {
  it('costs a normal step one check: no park, no extension event and the step decision unchanged', async () => {
    const previous = vi.fn(async () => ({ action: 'continue' as const }));
    const target = session(previous); const hook = hooks(false);
    installStepHold(target, hook.value);
    expect(await target.agent.finishTurn!(turn(['a']))).toEqual({ action: 'continue' });
    expect(previous).toHaveBeenCalledOnce();
    expect(hook.value.active).toHaveBeenCalledOnce();
    expect(hook.value.parked).not.toHaveBeenCalled();
    // An ordinary tool call is not remembered.
    expect(await target.agent.afterToolCall!({ toolCall: { id: 'a' }, result: { content: [] } } as never)).toBeUndefined();
  });

  it('parks a step whose tool calls continue the run and returns its decision when released', async () => {
    const target = session(async () => undefined); const hook = hooks(true);
    installStepHold(target, hook.value);
    let done = false;
    const decision = target.agent.finishTurn!(turn(['a', 'b'])).then(value => { done = true; return value; });
    await vi.waitFor(() => expect(hook.parked).toHaveLength(1));
    expect(hook.parked[0]!.leaf).toBe('leaf');
    await Promise.resolve(); expect(done).toBe(false);
    hook.parked[0]!.release('continue');
    expect(await decision).toBeUndefined();
    expect(hook.value.released).toHaveBeenCalledWith(hook.parked[0]);
  });

  it('ends a parked run without another request when its run is aborted', async () => {
    const target = session(); const hook = hooks(true); const controller = new AbortController();
    installStepHold(target, hook.value);
    const decision = target.agent.finishTurn!(turn(['a']), controller.signal);
    await vi.waitFor(() => expect(hook.parked).toHaveLength(1));
    controller.abort();
    expect(await decision).toEqual({ action: 'end' });
  });

  it.each([
    ['a final answer', turn([])],
    ['a failed response', turn(['a'], 'error')],
    ['an aborted response', turn(['a'], 'aborted')],
  ])('never parks %s', async (_label, step) => {
    const target = session(); const hook = hooks(true);
    installStepHold(target, hook.value);
    expect(await target.agent.finishTurn!(step)).toBeUndefined();
    expect(hook.value.parked).not.toHaveBeenCalled();
  });

  it('never parks a step whose tool calls all end the run', async () => {
    const target = session(); const hook = hooks(true);
    installStepHold(target, hook.value);
    await target.agent.afterToolCall!({ toolCall: { id: 'a' }, result: { content: [], terminate: true } } as never);
    expect(await target.agent.finishTurn!(turn(['a']))).toBeUndefined();
    expect(hook.value.parked).not.toHaveBeenCalled();
  });

  it('keeps the end decision of an earlier hook', async () => {
    const target = session(async () => ({ action: 'end' as const })); const hook = hooks(true);
    installStepHold(target, hook.value);
    expect(await target.agent.finishTurn!(turn(['a']))).toEqual({ action: 'end' });
    expect(hook.value.parked).not.toHaveBeenCalled();
  });
});

describe('continue record', () => {
  const record = { version: 1, session: 's', root: 'r', run: { id: 'run', origin: { kind: 'tui', attachment: 'a' } }, leaf: 'leaf',
    queue: [{ kind: 'follow_up', origin: { kind: 'tui', attachment: 'a' }, message: { role: 'user', content: [{ type: 'text', text: 'next' }], timestamp: 2 } }] };

  it('reads version 1 with its queued input', () => {
    expect(parseContinueRecord(record)).toEqual(record);
  });

  it.each([
    ['another version', { ...record, version: 2 }],
    ['a queued message that is not user input', { ...record, queue: [{ ...record.queue[0], message: { role: 'assistant', content: [], timestamp: 2 } }] }],
    ['no transcript leaf', { ...record, leaf: '' }],
  ])('rejects %s', (_label, value) => {
    expect(() => parseContinueRecord(value)).toThrow();
  });
});
