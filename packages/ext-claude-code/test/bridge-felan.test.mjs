import { setImmediate } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateClaudeCodeBridge, supportsPerTurnEffort, __test } from '../src/bridge/index.js';
import { PI_PREAMBLE } from '../src/bridge/prompt-capture.js';
import { diagLogPath } from '../src/bridge/log-paths.js';
import { QueryContext, resetCtx } from '../src/bridge/query-state.js';
import { rememberSessionCwd, sessionCwdFor } from '../src/bridge/session-cwd.js';
import { setClaudeAgentSdk } from '../src/sdk/runtime.js';
import { fakeSdk } from './upstream/lib/fake-sdk.mjs';

const user = { role: 'user', content: 'Give one recommendation.', timestamp: 0 };
const context = { systemPrompt: 'You are an advisor.', messages: [user] };
const anthropicKeys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'];
const activations = [];

function capturedContext() {
  const systemPrompt = 'Felan provider test: captured system prompt.';
  __test.promptCaptures.record(systemPrompt, { custom: 'Captured instructions.', contextFiles: [], skills: [] });
  return { systemPrompt, messages: [user] };
}

function activate(settings = {}) {
  const handlers = new Map();
  const registrations = [];
  const sessions = new Map();
  activateClaudeCodeBridge({
    on: (event, handler) => handlers.set(event, handler),
    registerProvider: (id, provider) => registrations.push({ id, provider }),
  }, { settings, agentDir: process.env.PI_CODING_AGENT_DIR });
  const provider = registrations[0].provider;
  const emit = (event, data, ctx) => handlers.get(event)?.(data, ctx);
  const result = {
    registrations,
    provider,
    model: provider.models[0],
    emit,
    start(id, reason = 'new', cwd = process.env.PI_CODING_AGENT_DIR) {
      const ctx = { cwd, ui: { notify: vi.fn() }, sessionManager: { getSessionId: () => id } };
      sessions.set(id, ctx);
      emit('session_start', { reason }, ctx);
      return ctx;
    },
    shutdown(id) {
      emit('session_shutdown', {}, sessions.get(id));
      sessions.delete(id);
    },
    cleanup() {
      for (const id of sessions.keys()) result.shutdown(id);
    },
  };
  activations.push(result);
  return result;
}

function injectQuery(messages = [{ type: 'result', subtype: 'success', result: 'Recommendation.' }], error) {
  const calls = [];
  __test.setQuery((request) => {
    const query = (async function* () {
      for (const message of messages) yield message;
      if (error) throw error;
    })();
    query.interrupt = vi.fn(async () => {});
    query.close = vi.fn();
    calls.push({ ...request, query });
    return query;
  });
  return calls;
}

async function run(bridge, input = context, options) {
  const result = await bridge.provider.streamSimple(bridge.model, input, options).result();
  await setImmediate();
  return result;
}

// Answers each prompt read from stdin, like the CLI in streaming-input mode, until stdin closes.
function injectLiveQuery(turns = [], applyFlagSettings = async () => {}, afterInputClosed = []) {
  const calls = [];
  __test.setQuery((request) => {
    const call = { ...request, prompts: [], exited: false };
    let close;
    const closed = new Promise((resolve) => { close = resolve; });
    const query = (async function* () {
      try {
        for await (const message of request.prompt) {
          call.prompts.push(message);
          const turn = turns[call.prompts.length - 1] ?? {};
          yield { type: 'system', subtype: 'init', session_id: request.options.resume ?? 'cc-live' };
          if (turn.wait && await Promise.race([turn.wait.then(() => false), closed.then(() => true)])) return;
          yield turn.result ?? { type: 'result', subtype: 'success', result: `Answer ${call.prompts.length}.` };
          for (const message of turn.after ?? []) yield message;
          if (turn.crash) throw new Error('Claude Code process exited with code 1');
          if (turn.hold && await Promise.race([turn.hold.then(() => false), closed.then(() => true)])) return;
        }
        for (const message of afterInputClosed) yield message;
      } finally {
        call.exited = true;
      }
    })();
    query.interrupt = vi.fn(async () => {});
    query.close = vi.fn(() => close());
    query.applyFlagSettings = vi.fn(async (settings) => {
      call.flagSettings = [...call.flagSettings ?? [], { settings, promptsBefore: call.prompts.length }];
      return applyFlagSettings(settings);
    });
    calls.push(Object.assign(call, { query }));
    return query;
  });
  return calls;
}

function followUp(input, answer, text) {
  return { ...input, messages: [...input.messages, answer, { role: 'user', content: text, timestamp: 0 }] };
}

async function consumeRateLimitEvent(model, piSessionId, status = 'rejected') {
  const c = new QueryContext();
  c.piSessionId = piSessionId;
  c.currentPiStream = { push() {}, end() {} };
  c.resetTurnState(model);
  await __test.consumeQuery((async function* () {
    yield { type: 'rate_limit_event', rate_limit_info: { status, utilization: 0.85, rateLimitType: 'five_hour' } };
  })(), new Map(), model, () => false, c);
}

beforeEach(() => {
  resetCtx();
  __test.resetSharedSession();
  setClaudeAgentSdk(fakeSdk());
});

afterEach(async () => {
  await setImmediate();
  for (const bridge of activations.splice(0)) bridge.cleanup();
  __test.resetSharedSession();
  __test.setQuery(null);
  setClaudeAgentSdk(undefined);
  vi.unstubAllEnvs();
  expect(__test.activeQueryContexts.size).toBe(0);
});

describe('Felan provider registration and lifecycle', () => {
  it('registers for every activation with the same stream function before session_start', () => {
    const a = activate();
    const b = activate();
    expect(a.registrations).toHaveLength(1);
    expect(b.registrations).toHaveLength(1);
    expect(a.registrations[0].id).toBe('claude-code');
    expect(b.provider.streamSimple).toBe(a.provider.streamSimple);
    a.start('A');
    b.start('B');
    expect(a.registrations).toHaveLength(1);
    expect(b.registrations).toHaveLength(1);
  });

  it.each(['new', 'resume', 'fork'])('clears only the starting session on %s', async (reason) => {
    const a = activate();
    const b = activate();
    const oldA = a.start('A');
    const liveB = b.start('B');
    const mirrorB = { sessionId: 'cc-B', cursor: 7, cwd: liveB.cwd };
    __test.setSharedSession('A', { sessionId: 'cc-A', cursor: 4, cwd: oldA.cwd });
    __test.setSharedSession('B', mirrorB);
    __test.historyRewrittenBySession.add('A');
    __test.historyRewrittenBySession.add('B');
    rememberSessionCwd('A', '/obsolete-cwd');
    const nextA = a.start('A', reason, '/new-cwd');

    expect(__test.getSharedSession('A')).toBeNull();
    expect(__test.getSharedSession('B')).toBe(mirrorB);
    expect([...__test.historyRewrittenBySession]).toEqual(['B']);
    expect(sessionCwdFor('A')).toBe('/new-cwd');
    expect(sessionCwdFor('B')).toBe(liveB.cwd);
    await consumeRateLimitEvent(a.model, 'A');
    await consumeRateLimitEvent(a.model, 'B');
    expect(oldA.ui.notify).not.toHaveBeenCalled();
    expect(nextA.ui.notify).toHaveBeenCalledTimes(1);
    expect(liveB.ui.notify).toHaveBeenCalledTimes(1);
  });

  it('shutting down A preserves B mirror, rewrite mark, cwd and warning UI', async () => {
    const a = activate();
    const b = activate();
    const ctxA = a.start('A');
    const ctxB = b.start('B');
    const mirrorB = { sessionId: 'cc-B', cursor: 7, cwd: ctxB.cwd };
    __test.setSharedSession('A', { sessionId: 'cc-A', cursor: 4, cwd: ctxA.cwd });
    __test.setSharedSession('B', mirrorB);
    __test.historyRewrittenBySession.add('A');
    __test.historyRewrittenBySession.add('B');
    a.shutdown('A');

    expect(__test.getSharedSession('A')).toBeNull();
    expect(__test.getSharedSession('B')).toBe(mirrorB);
    expect([...__test.historyRewrittenBySession]).toEqual(['B']);
    expect(sessionCwdFor('A')).toBe(process.cwd());
    expect(sessionCwdFor('B')).toBe(ctxB.cwd);
    for (const id of ['A', 'unknown', null, 'B']) {
      await consumeRateLimitEvent(a.model, id);
      __test.verifyWrittenSession(join(ctxB.cwd, 'missing.jsonl'), 'cc', 1, ctxB.cwd, id);
    }
    expect(ctxA.ui.notify).not.toHaveBeenCalled();
    expect(ctxB.ui.notify.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining('subscription rate limit reached'),
      expect.stringContaining('Session file issue'),
    ]);
  });

  it('leaves plan-utilization warnings to the status bar', async () => {
    const bridge = activate();
    const ctx = bridge.start('warned');
    await consumeRateLimitEvent(bridge.model, 'warned', 'allowed_warning');
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it.each(['shutdown', 'new', 'resume', 'fork'])('does not replant a mirror after %s while a query finishes', async (event) => {
    const bridge = activate();
    bridge.start('closing-session');
    const { promise, resolve } = Promise.withResolvers();
    __test.setQuery(() => {
      const query = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'cc-late' };
        await promise;
        yield { type: 'result', subtype: 'success', result: 'Late answer.' };
      })();
      query.interrupt = vi.fn(async () => {});
      query.close = vi.fn();
      return query;
    });
    const pending = run(bridge, capturedContext(), { sessionId: 'closing-session' });
    await setImmediate();
    expect(__test.activeQueryContexts.size).toBe(1);
    if (event === 'shutdown') bridge.shutdown('closing-session');
    else bridge.start('closing-session', event);
    resolve();
    expect((await pending).stopReason).toBe('stop');
    expect(__test.getSharedSession('closing-session')).toBeNull();
  });

  it.each(['success', 'error', 'abort'])('does not change a replacement mirror after a cleared query ends with %s', async (outcome) => {
    const bridge = activate();
    bridge.start('restarted-session');
    const { promise, resolve } = Promise.withResolvers();
    __test.setQuery(() => {
      const query = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'cc-obsolete' };
        await promise;
        if (outcome === 'error') throw new Error('Late failure');
        yield { type: 'result', subtype: 'success', result: 'Late answer.' };
      })();
      query.interrupt = vi.fn(async () => {});
      query.close = vi.fn();
      return query;
    });
    const controller = new AbortController();
    const pending = run(bridge, capturedContext(), { sessionId: 'restarted-session', signal: controller.signal });
    await setImmediate();
    bridge.start('restarted-session', 'resume');
    const replacement = { sessionId: 'cc-replacement', cursor: 3, cwd: process.env.PI_CODING_AGENT_DIR };
    __test.setSharedSession('restarted-session', replacement);
    if (outcome === 'abort') controller.abort();
    resolve();
    expect((await pending).stopReason).toBe(outcome === 'success' ? 'stop' : outcome === 'abort' ? 'aborted' : 'error');
    expect(__test.getSharedSession('restarted-session')).toBe(replacement);
    expect(replacement).not.toHaveProperty('needsRebuild');
  });
});

describe('Felan live Claude Code process', () => {
  const readTool = { name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } };

  it('answers the next prompt on the same process and stops it when the session shuts down', async () => {
    const bridge = activate();
    const ctx = bridge.start('live');
    const calls = injectLiveQuery();
    const first = capturedContext();
    const answer = await run(bridge, first, { sessionId: 'live' });
    expect(answer.content).toEqual([{ type: 'text', text: 'Answer 1.' }]);
    expect(calls[0].exited).toBe(false);
    expect(__test.liveQueries.get('live')?.idle).toBe(true);
    expect(__test.activeQueryContexts.size).toBe(0);

    const second = await run(bridge, followUp(first, answer, 'And another?'), { sessionId: 'live' });
    expect(second.content).toEqual([{ type: 'text', text: 'Answer 2.' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].prompts.map(({ message }) => message.content)).toEqual([
      [{ type: 'text', text: user.content }], [{ type: 'text', text: 'And another?' }],
    ]);
    expect(__test.getSharedSession('live')).toMatchObject({ sessionId: 'cc-live', cursor: 3 });

    await bridge.emit('session_shutdown', {}, ctx);
    expect(calls[0].exited).toBe(true);
    expect(__test.liveQueries.has('live')).toBe(false);
  });

  it.each([
    ['tools', (input) => ({ ...input, tools: [readTool] })],
    ['history', (input) => ({ ...input, messages: [user, { role: 'assistant', content: [], timestamp: 0 }, ...input.messages.slice(1)] })],
  ])('resumes on a fresh process once the live one exits when %s changed', async (_label, change) => {
    const bridge = activate();
    bridge.start('changed');
    const calls = injectLiveQuery();
    const first = capturedContext();
    const answer = await run(bridge, first, { sessionId: 'changed' });
    const output = await run(bridge, change(followUp(first, answer, 'Next.')), { sessionId: 'changed' });
    expect(output.content).toEqual([{ type: 'text', text: 'Answer 1.' }]);
    expect(calls).toHaveLength(2);
    expect(calls[0].exited).toBe(true);
    expect(calls[1].options.resume).toBe('cc-live');
  });

  it('applies another thinking level to the running process before writing the prompt', async () => {
    const bridge = activate();
    bridge.start('effort');
    const calls = injectLiveQuery();
    const model = bridge.provider.models.find(({ id }) => id === 'claude-opus-5-5');
    const first = capturedContext();
    const answer = (await bridge.provider.streamSimple(model, first, { sessionId: 'effort', reasoning: 'high' }).result());
    await setImmediate();
    const second = await bridge.provider.streamSimple(model, followUp(first, answer, 'Quick one.'), { sessionId: 'effort', reasoning: 'low' }).result();
    expect(second.content).toEqual([{ type: 'text', text: 'Answer 2.' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].options.effort).toBe('high');
    expect(calls[0].flagSettings).toEqual([{ settings: { effortLevel: 'low' }, promptsBefore: 1 }]);
    expect(calls[0].prompts).toHaveLength(2);
    expect(__test.liveQueries.get('effort')?.config.effort).toBe('low');
  });

  it.each([
    ['nothing', []],
    ['a stray frame', [{ type: 'system', subtype: 'status', status: null }]],
  ])('reruns the turn on a fresh process when the running one refuses the thinking level and sends %s', async (_label, afterInputClosed) => {
    const bridge = activate();
    bridge.start('refused');
    const calls = injectLiveQuery([], async () => { throw new Error('unsupported control request'); }, afterInputClosed);
    const model = bridge.provider.models.find(({ id }) => id === 'claude-opus-5-5');
    const first = capturedContext();
    const answer = await bridge.provider.streamSimple(model, first, { sessionId: 'refused', reasoning: 'high' }).result();
    await setImmediate();
    const output = await bridge.provider.streamSimple(model, followUp(first, answer, 'Quick one.'), { sessionId: 'refused', reasoning: 'low' }).result();
    expect(output.content).toEqual([{ type: 'text', text: 'Answer 1.' }]);
    expect(calls).toHaveLength(2);
    expect(calls[0].prompts).toHaveLength(1);
    expect(calls[0].exited).toBe(true);
    expect(calls[1].options).toMatchObject({ effort: 'low', resume: 'cc-live' });
  });

  it('reruns the turn on a fresh process when the query cannot change the thinking level', async () => {
    const bridge = activate();
    bridge.start('no-flags');
    const calls = injectLiveQuery();
    const model = bridge.provider.models.find(({ id }) => id === 'claude-opus-5-5');
    const first = capturedContext();
    const answer = await bridge.provider.streamSimple(model, first, { sessionId: 'no-flags', reasoning: 'high' }).result();
    await setImmediate();
    delete calls[0].query.applyFlagSettings;
    const output = await bridge.provider.streamSimple(model, followUp(first, answer, 'Quick one.'), { sessionId: 'no-flags', reasoning: 'low' }).result();
    expect(output.content).toEqual([{ type: 'text', text: 'Answer 1.' }]);
    expect(calls).toHaveLength(2);
    expect(calls[0].prompts).toHaveLength(1);
    expect(calls[1].options).toMatchObject({ effort: 'low', resume: 'cc-live' });
  });

  it('ends an aborted turn without writing its prompt while the thinking level is pending', async () => {
    const bridge = activate();
    bridge.start('pending-effort');
    const calls = injectLiveQuery([], () => new Promise(() => {}));
    const model = bridge.provider.models.find(({ id }) => id === 'claude-opus-5-5');
    const first = capturedContext();
    const answer = await bridge.provider.streamSimple(model, first, { sessionId: 'pending-effort', reasoning: 'high' }).result();
    await setImmediate();
    const controller = new AbortController();
    const pending = bridge.provider.streamSimple(model, followUp(first, answer, 'Never sent.'), {
      sessionId: 'pending-effort', reasoning: 'max', signal: controller.signal,
    }).result();
    await setImmediate();
    expect(calls[0].flagSettings).toEqual([{ settings: { effortLevel: 'max' }, promptsBefore: 1 }]);
    controller.abort();
    expect((await pending).stopReason).toBe('aborted');
    await setImmediate();
    expect(calls).toHaveLength(1);
    expect(calls[0].prompts).toHaveLength(1);
    expect(calls[0].exited).toBe(true);
  });

  it('reruns the turn on a fresh process when the thinking level gets no answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const bridge = activate();
      bridge.start('silent');
      const calls = injectLiveQuery([], () => new Promise(() => {}));
      const model = bridge.provider.models.find(({ id }) => id === 'claude-opus-5-5');
      const first = capturedContext();
      const answer = await bridge.provider.streamSimple(model, first, { sessionId: 'silent', reasoning: 'high' }).result();
      await setImmediate();
      const pending = bridge.provider.streamSimple(model, followUp(first, answer, 'Quick one.'), { sessionId: 'silent', reasoning: 'xhigh' }).result();
      await setImmediate();
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await pending).content).toEqual([{ type: 'text', text: 'Answer 1.' }]);
      expect(calls).toHaveLength(2);
      expect(calls[0].prompts).toHaveLength(1);
      expect(calls[1].options).toMatchObject({ effort: 'xhigh', resume: 'cc-live' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops declaring cache-safe thinking changes for a model Claude Code reports without per-turn effort', async () => {
    const bridge = activate();
    bridge.start('reported');
    const model = bridge.provider.models.find(({ id }) => id === 'claude-opus-5-5');
    const declared = () => supportsPerTurnEffort({ provider: 'claude-code', id: model.id, reasoning: true });
    const init = (active) => [
      { type: 'system', subtype: 'init', session_id: 'cc-reported', per_turn_effort_active: active },
      { type: 'result', subtype: 'success', result: 'Done.' },
    ];
    injectQuery(init(false));
    await bridge.provider.streamSimple(model, capturedContext(), { sessionId: 'reported', reasoning: 'high' }).result();
    expect(declared()).toBe(false);
    __test.resetSharedSession('reported');
    bridge.start('reported-again');
    injectQuery(init(true));
    await bridge.provider.streamSimple(model, capturedContext(), { sessionId: 'reported-again', reasoning: 'high' }).result();
    expect(declared()).toBe(true);
  });

  it('disables thinking for the off level on a fresh process where the model allows it', async () => {
    const bridge = activate();
    bridge.start('off');
    const calls = injectLiveQuery();
    const model = bridge.provider.models.find(({ id }) => id === 'claude-haiku-5-5');
    const first = capturedContext();
    const answer = await bridge.provider.streamSimple(model, first, { sessionId: 'off', reasoning: 'high' }).result();
    await setImmediate();
    await bridge.provider.streamSimple(model, followUp(first, answer, 'No thinking.'), { sessionId: 'off' }).result();
    expect(calls).toHaveLength(2);
    expect(calls[0].options).not.toHaveProperty('thinking');
    expect(calls[0].options.extraArgs['thinking-display']).toBe('summarized');
    expect(calls[1].options).toMatchObject({ thinking: { type: 'disabled' }, resume: 'cc-live' });
    expect(calls[1].options).not.toHaveProperty('effort');
    expect(calls[1].options.extraArgs).not.toHaveProperty('thinking-display');
    expect(calls[0].query.applyFlagSettings).not.toHaveBeenCalled();

    bridge.start('forced-adaptive');
    const forced = bridge.provider.models.find(({ id }) => id === 'claude-opus-5-5');
    await bridge.provider.streamSimple(forced, capturedContext(), { sessionId: 'forced-adaptive' }).result();
    expect(calls[2].options).not.toHaveProperty('thinking');
  });

  it('declares cache-safe thinking changes only for per-turn effort Claude Code models', () => {
    const reasoning = true;
    expect(supportsPerTurnEffort({ provider: 'claude-code', id: 'claude-opus-5-5', reasoning })).toBe(true);
    expect(supportsPerTurnEffort({ provider: 'claude-code', id: 'claude-sonnet-5-5', reasoning })).toBe(true);
    expect(supportsPerTurnEffort({ provider: 'claude-code', id: 'claude-opus-4-8', reasoning })).toBe(false);
    expect(supportsPerTurnEffort({ provider: 'anthropic', id: 'claude-opus-5-5', reasoning })).toBe(false);
    expect(supportsPerTurnEffort({ provider: 'claude-code', id: 'claude-opus-5-5', reasoning: false })).toBe(false);
  });

  it('retires an idle process when the session switches to another model', async () => {
    const bridge = activate();
    const ctx = bridge.start('switching');
    const calls = injectLiveQuery();
    await run(bridge, capturedContext(), { sessionId: 'switching' });
    bridge.emit('model_select', { model: { provider: 'claude-code', id: bridge.model.id } }, ctx);
    expect(__test.liveQueries.has('switching')).toBe(true);
    bridge.emit('model_select', { model: { provider: 'anthropic', id: bridge.model.id } }, ctx);
    await __test.retireLiveQuery('switching', 'test');
    expect(calls[0].exited).toBe(true);
    expect(__test.liveQueries.has('switching')).toBe(false);
  });

  it('ends the process with a failed turn', async () => {
    const bridge = activate();
    bridge.start('failing');
    const calls = injectLiveQuery([{ result: { type: 'result', subtype: 'error_during_execution', errors: ['overloaded'] } }]);
    const output = await run(bridge, capturedContext(), { sessionId: 'failing' });
    expect(output.stopReason).toBe('error');
    expect(output.errorMessage).toContain('overloaded');
    expect(calls[0].exited).toBe(true);
    expect(__test.liveQueries.has('failing')).toBe(false);
  });

  it('kills the process when a live turn is aborted', async () => {
    const bridge = activate();
    bridge.start('aborting');
    const calls = injectLiveQuery([{}, { wait: new Promise(() => {}) }]);
    const first = capturedContext();
    const answer = await run(bridge, first, { sessionId: 'aborting' });
    const controller = new AbortController();
    const pending = run(bridge, followUp(first, answer, 'Never answered.'), { sessionId: 'aborting', signal: controller.signal });
    await setImmediate();
    controller.abort();
    expect((await pending).stopReason).toBe('aborted');
    expect(calls[0].query.close).toHaveBeenCalled();
    expect(calls[0].exited).toBe(true);
    expect(__test.liveQueries.has('aborting')).toBe(false);
    expect(__test.getSharedSession('aborting')).toMatchObject({ needsRebuild: true, forceRotate: true });
  });

  it('reruns a prompt on a fresh process when the live one exited before answering it', async () => {
    const bridge = activate();
    bridge.start('exited');
    const { promise: exit, resolve: exitProcess } = Promise.withResolvers();
    const calls = [];
    __test.setQuery((request) => {
      const exitsAfterFirstTurn = calls.length === 0;
      const query = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: request.options.resume ?? 'cc-exited' };
        yield { type: 'result', subtype: 'success', result: `Answer from process ${calls.length}.` };
        if (exitsAfterFirstTurn) await exit;
      })();
      query.interrupt = async () => {};
      query.close = () => {};
      calls.push(request);
      return query;
    });
    const first = capturedContext();
    const answer = await run(bridge, first, { sessionId: 'exited' });
    expect(__test.liveQueries.get('exited')?.idle).toBe(true);
    const pending = run(bridge, followUp(first, answer, 'Again.'), { sessionId: 'exited' });
    await setImmediate();
    exitProcess();
    const output = await pending;
    expect(output.content).toEqual([{ type: 'text', text: 'Answer from process 2.' }]);
    expect(calls).toHaveLength(2);
    expect(calls[1].options.resume).toBe('cc-exited');
  });

  it('keeps a delivered answer intact when the idle process later fails', async () => {
    const bridge = activate();
    bridge.start('crashing');
    const calls = injectLiveQuery([{ crash: true }]);
    const answer = await run(bridge, capturedContext(), { sessionId: 'crashing' });
    await setImmediate();
    expect(calls[0].exited).toBe(true);
    expect(answer).toMatchObject({ stopReason: 'stop', content: [{ type: 'text', text: 'Answer 1.' }] });
    expect(answer).not.toHaveProperty('errorMessage');
  });

  it('ends a steered turn with its process, keeping an answer to an undrained steer in that turn', async () => {
    const bridge = activate();
    bridge.start('steered');
    const { promise: gate, resolve: open } = Promise.withResolvers();
    const calls = injectLiveQuery([{ wait: gate }]);
    const pending = run(bridge, capturedContext(), { sessionId: 'steered' });
    await setImmediate();
    const turn = [...__test.activeQueryContexts].find((c) => c.piSessionId === 'steered');
    void __test.deliverToolResults(turn, [], [{ type: 'text', text: 'Also mention testing.' }], 1);
    open();
    const output = await pending;
    expect(output.content.map((block) => block.text)).toEqual(['Answer 1.', 'Answer 2.']);
    expect(calls[0].prompts).toHaveLength(2);
    expect(calls[0].exited).toBe(true);
    expect(__test.liveQueries.has('steered')).toBe(false);
  });

  it('retires an idle process that answers a prompt pi never sent, and rebuilds the next turn', async () => {
    const bridge = activate();
    bridge.start('stray');
    const stray = { type: 'assistant', message: { id: 'msg_stray', content: [{ type: 'text', text: 'Unprompted.' }] } };
    const turns = [{ after: [stray] }];
    const calls = injectLiveQuery(turns);
    const first = capturedContext();
    const answer = await run(bridge, first, { sessionId: 'stray' });
    expect(answer.content).toEqual([{ type: 'text', text: 'Answer 1.' }]);
    expect(__test.liveQueries.has('stray')).toBe(false);
    expect(__test.getSharedSession('stray')?.needsRebuild).toBe(true);
    turns[0] = {};
    await run(bridge, followUp(first, answer, 'Next.'), { sessionId: 'stray' });
    expect(calls[0].exited).toBe(true);
    expect(calls).toHaveLength(2);
    expect(__test.getSharedSession('stray')?.needsRebuild).toBeFalsy();
  });

  it('aborts a call waiting on a retiring process without starting a query', async () => {
    const bridge = activate();
    const ctx = bridge.start('waiting');
    const { promise: hold, resolve: release } = Promise.withResolvers();
    const calls = injectLiveQuery([{ hold }]);
    const first = capturedContext();
    const answer = await run(bridge, first, { sessionId: 'waiting' });
    bridge.emit('model_select', { model: { provider: 'anthropic', id: bridge.model.id } }, ctx);
    const controller = new AbortController();
    const pending = run(bridge, followUp(first, answer, 'Too late.'), { sessionId: 'waiting', signal: controller.signal });
    await setImmediate();
    controller.abort();
    expect((await pending).stopReason).toBe('aborted');
    expect(calls).toHaveLength(1);
    release();
    await __test.retireLiveQuery('waiting', 'test');
    expect(calls[0].exited).toBe(true);
  });

  it('keeps one process per turn for sessions that never started', async () => {
    const bridge = activate();
    const calls = injectLiveQuery();
    expect((await run(bridge, { ...capturedContext(), tools: [readTool] }, { sessionId: 'not-started' })).stopReason).toBe('stop');
    expect(calls[0].exited).toBe(true);
    expect(__test.liveQueries.size).toBe(0);
  });
});

describe('Felan Claude Code child environment', () => {
  it('does not mutate the daemon environment at activation or query time', async () => {
    vi.stubEnv('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'daemon-value');
    for (const key of anthropicKeys) vi.stubEnv(key, `test-${key}`);
    const before = { ...process.env };
    const bridge = activate();
    bridge.start('env-session');
    const calls = injectQuery();
    await run(bridge, capturedContext(), { sessionId: 'env-session' });
    await run(bridge);
    expect(process.env).toEqual(before);
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.options.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
  });

  it.each([false, true])('filters both query paths with inheritAnthropicEnvironment=%s', async (inheritAnthropicEnvironment) => {
    for (const key of anthropicKeys) vi.stubEnv(key, `test-${key}`);
    vi.stubEnv('FELAN_BRIDGE_TEST_ENV', 'preserved');
    const bridge = activate({ inheritAnthropicEnvironment });
    bridge.start('env-session');
    const calls = injectQuery();
    expect((await run(bridge, capturedContext(), { sessionId: 'env-session' })).stopReason).toBe('stop');
    expect((await run(bridge)).stopReason).toBe('stop');
    expect(calls).toHaveLength(2);
    for (const { options } of calls) {
      expect(options.env).toMatchObject({ ...__test.CC_CHILD_ENV, FELAN_BRIDGE_TEST_ENV: 'preserved' });
      for (const key of anthropicKeys) {
        if (inheritAnthropicEnvironment) expect(options.env[key]).toBe(`test-${key}`);
        else expect(options.env).not.toHaveProperty(key);
      }
    }
  });
});

describe('Felan prompt-only calls', () => {
  it.each([undefined, []])('uses a nonpersistent isolated query with tools=%s', async (tools) => {
    const bridge = activate();
    const calls = injectQuery();
    const output = await run(bridge, { ...context, tools });
    expect(output.stopReason).toBe('stop');
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toBe(user.content);
    expect(calls[0].options).toMatchObject({ persistSession: false, maxTurns: 1, tools: [], systemPrompt: context.systemPrompt });
    expect(calls[0].query.close).toHaveBeenCalled();
    expect(__test.getSharedSession()).toBeNull();
  });

  it.each([undefined, [], null])('isolates a Models-service call with a synthetic session ID and tools=%s', async (tools) => {
    const bridge = activate();
    const calls = injectQuery();
    const sessionId = 'felan-models:3adc4ed4b815';
    const resolution = vi.spyOn(__test.promptCaptures, 'resolveOrDerive');
    try {
      const output = await run(bridge, { ...context, tools }, { sessionId });
      expect(output.stopReason).toBe('stop');
      expect(output.content).toEqual([{ type: 'text', text: 'Recommendation.' }]);
      expect(calls).toHaveLength(1);
      expect(calls[0].prompt).toBe(user.content);
      expect(calls[0].options).toMatchObject({ persistSession: false, maxTurns: 1, tools: [], systemPrompt: context.systemPrompt });
      expect(resolution).not.toHaveBeenCalled();
      expect(__test.getSharedSession(sessionId)).toBeNull();
    } finally {
      resolution.mockRestore();
    }
  });

  it.each([undefined, 'felan-models:captured', 'untracked-session'])('isolates exact and embedded captured prompts for untracked sessionId=%s', async (sessionId) => {
    const bridge = activate();
    const { systemPrompt } = capturedContext();
    const resolution = vi.spyOn(__test.promptCaptures, 'resolveOrDerive');
    try {
      for (const prompt of [systemPrompt, `Wrapper\n${systemPrompt}\nInstructions.`]) {
        const calls = injectQuery([
          { type: 'system', subtype: 'init', session_id: 'cc-isolated' },
          { type: 'result', subtype: 'success', result: 'Isolated answer.' },
        ]);
        const output = await run(bridge, { ...context, systemPrompt: prompt }, { sessionId });
        expect(output.stopReason).toBe('stop');
        expect(calls).toHaveLength(1);
        expect(calls[0].options).toMatchObject({ persistSession: false, maxTurns: 1, systemPrompt: prompt });
        expect(calls[0].query.close).toHaveBeenCalled();
        expect(__test.getSharedSession(sessionId ?? null)).toBeNull();
      }
      expect(resolution).not.toHaveBeenCalled();
    } finally {
      resolution.mockRestore();
    }
  });

  it.each(['new', 'resume', 'fork'])('fails closed for an uncaptured, tool-less live session after %s', async (reason) => {
    const bridge = activate();
    bridge.start('live-session', reason);
    const calls = injectQuery();
    const output = await run(bridge, context, { sessionId: 'live-session' });
    expect(output.stopReason).toBe('error');
    expect(output.errorMessage).toContain('prompt-capture: no capture');
    expect(calls).toHaveLength(0);
    expect(__test.getSharedSession('live-session')).toBeNull();
  });

  it.each(['captured-session', 'child-session'])('keeps exact and derived captures on the provider path for live sessionId=%s', async (sessionId) => {
    const bridge = activate();
    bridge.start(sessionId);
    const systemPrompt = `${PI_PREAMBLE}: Felan capture routing test.`;
    bridge.emit('before_agent_start', {
      messageType: 'user', prompt: '',
      systemPrompt,
      systemPromptOptions: { customPrompt: 'Retain captured instructions.' },
    });
    for (const prompt of [systemPrompt, `Child wrapper\n${systemPrompt}\nChild instructions.`]) {
      const calls = injectQuery([
        { type: 'system', subtype: 'init', session_id: 'cc-captured' },
        { type: 'result', subtype: 'success', result: 'Provider answer.' },
      ]);
      const output = await run(bridge, { ...context, systemPrompt: prompt }, { sessionId });
      expect(output.stopReason).toBe('stop');
      expect(calls).toHaveLength(1);
      expect(calls[0].options).not.toHaveProperty('persistSession', false);
      expect(calls[0].options.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' });
      expect(calls[0].options.systemPrompt.append).toContain('Retain captured instructions.');
      expect(calls[0].options.systemPrompt.append).not.toContain(PI_PREAMBLE);
      if (prompt !== systemPrompt) expect(calls[0].options.systemPrompt.append).toContain('Child wrapper');
      expect(__test.getSharedSession(sessionId)?.sessionId).toBe('cc-captured');
    }
  });

  it('untracks a shutdown session without untracking another live session', async () => {
    const a = activate();
    const b = activate();
    a.start('A');
    b.start('B');
    const calls = injectQuery();
    expect((await run(a, context, { sessionId: 'A' })).stopReason).toBe('error');
    expect(calls).toHaveLength(0);
    a.shutdown('A');
    expect((await run(a, context, { sessionId: 'A' })).stopReason).toBe('stop');
    expect(calls).toHaveLength(1);
    expect(calls[0].options.persistSession).toBe(false);
    const output = await run(b, context, { sessionId: 'B' });
    expect(output.stopReason).toBe('error');
    expect(output.errorMessage).toContain('prompt-capture: no capture');
    expect(calls).toHaveLength(1);
  });

  it.each([undefined, 'cleared-session'])('untracks cleared sessions with reset sessionId=%s', async (sessionId) => {
    const bridge = activate();
    bridge.start('cleared-session');
    __test.resetSharedSession(sessionId);
    const calls = injectQuery();
    expect((await run(bridge, context, { sessionId: 'cleared-session' })).stopReason).toBe('stop');
    expect(calls[0].options.persistSession).toBe(false);
  });

  it.each([undefined, 'felan-models:invalid-lifecycle'])('never tracks synthetic or undefined lifecycle sessionId=%s', async (sessionId) => {
    const bridge = activate();
    bridge.start(sessionId);
    const calls = injectQuery();
    expect((await run(bridge, context, { sessionId })).stopReason).toBe('stop');
    expect(calls[0].options.persistSession).toBe(false);
  });

  it('keeps a live session tracked after an SDK failure clears its mirror', async () => {
    const bridge = activate();
    bridge.start('failed-session');
    injectQuery([], new Error('SDK failure'));
    expect((await run(bridge, capturedContext(), { sessionId: 'failed-session' })).stopReason).toBe('error');
    const calls = injectQuery();
    const output = await run(bridge, context, { sessionId: 'failed-session' });
    expect(output.stopReason).toBe('error');
    expect(output.errorMessage).toContain('prompt-capture: no capture');
    expect(calls).toHaveLength(0);
  });

  it('normalizes transcript prompt and tool removals before selecting the isolated path', async () => {
    const bridge = activate();
    const calls = injectQuery();
    const tool = { name: 'read', description: 'read', parameters: { type: 'object', properties: {} } };
    const output = await run(bridge, { messages: [
      { role: 'system', content: context.systemPrompt, tools: [tool], timestamp: 0 },
      { role: 'system', content: '', toolsRemoved: ['read'], timestamp: 1 },
      user,
    ] });
    expect(output.stopReason).toBe('stop');
    expect(calls[0].options.persistSession).toBe(false);
    expect(calls[0].options.systemPrompt).toBe(context.systemPrompt);
  });

  it.each([false, true])('preserves images in isolated prompts with accompanying text=%s', async (withText) => {
    const bridge = activate();
    const calls = injectQuery();
    const image = { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' };
    const content = [...(withText ? [{ type: 'text', text: 'Describe this image.' }] : []), image];
    const output = await run(bridge, { ...context, messages: [{ ...user, content }] });
    expect(output.stopReason).toBe('stop');
    expect(calls[0].options.persistSession).toBe(false);
    const input = [];
    for await (const message of calls[0].prompt) input.push(message);
    expect(input).toEqual([{
      type: 'user', parent_tool_use_id: null,
      message: { role: 'user', content: [
        ...(withText ? [{ type: 'text', text: 'Describe this image.' }] : []),
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.data } },
      ] },
    }]);
  });

  it.each([
    { label: 'tools', input: { ...context, tools: [{ name: 'read', description: 'read', parameters: {} }] } },
    { label: 'multiple messages', input: { ...context, messages: [user, user] } },
    { label: 'non-user message', input: { ...context, messages: [{ role: 'assistant', content: [], timestamp: 0 }] } },
  ])('preserves capture failures for $label instead of bypassing them', async ({ input, options }) => {
    const bridge = activate();
    const calls = injectQuery();
    const output = await run(bridge, input, options);
    expect(output.stopReason).toBe('error');
    expect(output.errorMessage).toContain('prompt-capture: no capture');
    expect(calls).toHaveLength(0);
  });

  it('keeps cacheRetention none routing for a session-scoped multi-message summary', async () => {
    const bridge = activate();
    bridge.start('summary');
    const calls = injectQuery();
    const output = await run(bridge, { ...context, messages: [user, user] }, { sessionId: 'summary', cacheRetention: 'none' });
    expect(output.stopReason).toBe('stop');
    expect(calls[0].options.persistSession).toBe(false);
  });

  it.each([
    PI_PREAMBLE,
    `Intro\n${PI_PREAMBLE}, with tools.`,
    'See docs/custom-provider.md and docs/packages.md.',
  ])('rejects isolated harness text: %s', async (systemPrompt) => {
    const bridge = activate();
    const calls = injectQuery();
    for (const options of [undefined, { sessionId: 'felan-models:guard' }, { cacheRetention: 'none', sessionId: 'summary' }]) {
      const output = await run(bridge, { ...context, systemPrompt }, options);
      expect(output.stopReason).toBe('error');
      expect(output.errorMessage).toContain('prompt-capture: refusing to send this prompt');
      expect(output.errorMessage).toContain('@felan-ai/ext-claude-code README (Compatibility section)');
      expect(output.errorMessage).toContain('/claude-code status');
      expect(output.errorMessage).not.toContain('Compatibility with other extensions');
    }
    expect(calls).toHaveLength(0);
  });

  it.each([`A quotation: ${PI_PREAMBLE}`, 'See docs/custom-provider.md.'])('allows non-harness references: %s', async (systemPrompt) => {
    const bridge = activate();
    injectQuery();
    expect((await run(bridge, { ...context, systemPrompt })).stopReason).toBe('stop');
  });
});

describe('Felan troubleshooting guidance', () => {
  it('keeps session diagnostics while referring users to the shipped README and status command', () => {
    const bridge = activate();
    const ctx = bridge.start('diagnostic-session');
    const jsonlPath = join(ctx.cwd, 'missing-session.jsonl');
    __test.verifyWrittenSession(jsonlPath, 'cc-diagnostic', 1, ctx.cwd, 'diagnostic-session');
    const [message, severity] = ctx.ui.notify.mock.calls[0];
    expect(severity).toBe('warning');
    expect(message).toContain('@felan-ai/ext-claude-code README (Compatibility section)');
    expect(message).toContain('/claude-code status');
    expect(message).not.toContain('docs/user-guide/claude-code.md');
    expect(message).toContain('CLAUDE_BRIDGE_DEBUG=1');
    expect(message).not.toContain('elidickinson');
    expect(message).not.toContain('CLAUDE_CONFIG_DIR=');
    const diagnostic = JSON.parse(readFileSync(diagLogPath(), 'utf8').trim().split('\n').at(-1));
    expect(diagnostic).toMatchObject({ label: 'session_verify_fail', jsonlPath, cwd: ctx.cwd, claudeConfigDir: process.env.CLAUDE_CONFIG_DIR });
    expect(diagnostic.msg).toBeTruthy();
  });

  it('preserves unresolved capture diagnostics and uses the shipped README and status command', async () => {
    const bridge = activate();
    const calls = injectQuery();
    const output = await run(bridge, { ...context, tools: [{ name: 'read', description: 'Read', parameters: {} }] });
    expect(output.stopReason).toBe('error');
    expect(output.errorMessage).toContain('prompt-capture: no capture');
    expect(output.errorMessage).toContain("Felan's Claude Code extension");
    expect(output.errorMessage).toContain('@felan-ai/ext-claude-code README (Compatibility section)');
    expect(output.errorMessage).toContain('/claude-code status');
    expect(output.errorMessage).not.toContain('docs/user-guide/claude-code.md');
    expect(output.errorMessage).not.toContain('after claude-bridge');
    const diagnostic = JSON.parse(readFileSync(diagLogPath(), 'utf8').trim().split('\n').at(-1));
    expect(diagnostic).toMatchObject({ label: 'prompt_capture_unresolved', promptChars: context.systemPrompt.length });
    expect(calls).toHaveLength(0);
  });
});

describe('Felan Claude Code authentication guidance', () => {
  const failures = ['Invalid API key', 'Please run /login', 'not logged in', 'authentication_error', 'OAuth token has expired', 'Invalid bearer token'];

  it.each(failures)('labels %s in provider and isolated result errors', async (failure) => {
    const bridge = activate();
    bridge.start('auth');
    injectQuery([{ type: 'result', subtype: 'success', is_error: true, result: failure }]);
    for (const options of [{ sessionId: 'auth' }, undefined]) {
      const output = await run(bridge, options ? capturedContext() : { messages: [user] }, options);
      expect(output.stopReason).toBe('error');
      expect(output.errorMessage).toContain('Claude Code is not signed in on this machine; run `claude` and then `/login`, then retry.');
      expect(output.errorMessage).toContain(failure);
      expect(output.errorMessage).not.toContain('inheritAnthropicEnvironment');
    }
  });

  it.each([false, true])('handles thrown SDK errors with inherited credentials=%s', async (inheritAnthropicEnvironment) => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'test-token');
    const bridge = activate({ inheritAnthropicEnvironment });
    bridge.start('auth');
    injectQuery([], new Error('Invalid bearer token'));
    for (const options of [{ sessionId: 'auth' }, undefined]) {
      const output = await run(bridge, options ? capturedContext() : { messages: [user] }, options);
      expect(output.errorMessage).toContain('run `claude` and then `/login`');
      expect(output.errorMessage.includes('inheritAnthropicEnvironment')).toBe(inheritAnthropicEnvironment);
      expect(output.errorMessage).not.toContain('test-token');
    }
  });

  it.each([{ sessionId: 'auth' }, undefined])('reports synchronous SDK failures on the stream with options=%s', async (options) => {
    const bridge = activate();
    bridge.start('auth');
    __test.setQuery(() => { throw new Error('Invalid API key'); });
    const output = await run(bridge, options ? capturedContext() : { messages: [user] }, options);
    expect(output.stopReason).toBe('error');
    expect(output.errorMessage).toContain('run `claude` and then `/login`');
  });

  it('retains query-time environment attribution when a later activation changes settings', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    const bridge = activate({ inheritAnthropicEnvironment: true });
    bridge.start('auth');
    __test.setQuery(() => {
      const query = (async function* () {
        activate({ inheritAnthropicEnvironment: false });
        yield { type: 'result', subtype: 'error_during_execution', errors: ['authentication_error'] };
      })();
      query.interrupt = async () => {};
      query.close = () => {};
      return query;
    });
    expect((await run(bridge, capturedContext(), { sessionId: 'auth' })).errorMessage).toContain('inheritAnthropicEnvironment');
  });

  it('does not diagnose a successful mention or unrelated error as an authentication failure', () => {
    expect(__test.resultErrorText({ type: 'result', subtype: 'success', result: 'Please run /login' })).toBeUndefined();
    expect(__test.resultErrorText({ type: 'result', subtype: 'error_during_execution', errors: ['overloaded'] })).toBe('overloaded');
    expect(__test.resultErrorText({ type: 'result', subtype: 'error_during_execution', error: { message: 'not logged in' } })).toContain('run `claude`');
    expect(__test.resultErrorText({ type: 'result', subtype: 'error_during_execution', result: 'not logged in' })).toContain('run `claude`');
  });
});

describe('Felan process-wide settings', () => {
  it('uses the latest activation settings even through the first registered provider', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://example.invalid');
    const first = activate({ pathToClaudeCodeExecutable: '/old/claude', inheritAnthropicEnvironment: false });
    first.start('settings');
    activate({ pathToClaudeCodeExecutable: '/latest/claude', inheritAnthropicEnvironment: true, strictMcpConfig: false, autoMemoryEnabled: true });
    const calls = injectQuery();
    await run(first, capturedContext(), { sessionId: 'settings' });
    await run(first);
    expect(calls).toHaveLength(2);
    for (const { options } of calls) {
      expect(options.pathToClaudeCodeExecutable).toBe('/latest/claude');
      expect(options.env.ANTHROPIC_BASE_URL).toBe('https://example.invalid');
    }
    expect(calls[0].options.extraArgs).not.toHaveProperty('strict-mcp-config');
    expect(calls[0].options.settings.autoMemoryEnabled).toBe(true);
  });
});
