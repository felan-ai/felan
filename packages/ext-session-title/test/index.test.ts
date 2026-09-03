import type { FelanExtensionAPI, ExtensionContext, Model, SessionEntry } from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionTitleExtension, type SessionTitleHost } from '../src/index.js';

const pendingTasks: Promise<unknown>[] = [];

afterEach(async () => {
  await Promise.allSettled(pendingTasks.splice(0));
});

describe('@felan-ai/ext-session-title', () => {
  it('generates one title from the first unnamed root prompt', async () => {
    const complete = vi.fn().mockResolvedValue(response('Title: "Review auth regressions."'));
    const setSessionName = vi.fn();
    const host = testHost(complete);
    const handlers = install(createSessionTitleExtension(host), setSessionName);
    const ctx = context({ entries: [] });

    handlers.before({ prompt: 'Review the authentication flow.' }, ctx);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(setSessionName).toHaveBeenCalledWith('Review auth regressions'));
    handlers.before({ prompt: 'Follow up.' }, ctx);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(complete).toHaveBeenCalledOnce();

    expect(complete.mock.calls[0]?.[0].model.id).toBe('cheap');
    expect(complete.mock.calls[0]?.[0].context.systemPrompt).toContain('untrusted source text');
    expect(complete.mock.calls[0]?.[0].context.messages[0]?.content).toContain(
      'Review the authentication flow.',
    );
  });

  it('selects the cheapest text-capable model and bounds the prompt', async () => {
    const complete = vi.fn().mockResolvedValue(response('Fix login timeout'));
    const host = testHost(complete, [model('expensive', 10, 10), model('cheap', 1, 1), model('image', 0, 0, ['image'])]);
    const handlers = install(createSessionTitleExtension(host), vi.fn());
    handlers.before({ prompt: 'x'.repeat(10_000) }, context({ entries: [] }));
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());

    expect(complete.mock.calls[0]?.[0].model.id).toBe('cheap');
    expect(complete.mock.calls[0]?.[0].context.messages[0]?.content).toContain('x'.repeat(4_000));
    expect(complete.mock.calls[0]?.[0].options).toMatchObject({ maxTokens: 64, maxRetries: 0, reasoning: 'minimal', timeoutMs: 30_000 });
  });

  it('retries a failed title request on the next prompt', async () => {
    const complete = vi.fn()
      .mockRejectedValueOnce(new Error('title model unavailable'))
      .mockResolvedValue(response('Recovered title'));
    const host = testHost(complete);
    const setSessionName = vi.fn();
    const handlers = install(createSessionTitleExtension(host), setSessionName);
    const ctx = context({ entries: [] });

    handlers.before({ prompt: 'First try.' }, ctx);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    handlers.before({ prompt: 'Second try.' }, ctx);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(setSessionName).toHaveBeenCalledWith('Recovered title'));
  });

  it('stops retrying after repeated failures or permanent skips', async () => {
    const complete = vi.fn().mockRejectedValue(new Error('boom'));
    const skip = vi.fn();
    const host = { ...testHost(complete), reportSkip: skip };
    const handlers = install(createSessionTitleExtension(host), vi.fn());
    const ctx = context({ entries: [] });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      handlers.before({ prompt: `Try ${attempt}.` }, ctx);
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(Math.min(attempt + 1, 3)));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(complete).toHaveBeenCalledTimes(3);

    const declineHost = { ...testHost(vi.fn()), reportSkip: skip };
    const decline = install(createSessionTitleExtension(declineHost), vi.fn(), { mode: 'print' });
    decline.before({ prompt: 'Do work' }, context({ entries: [], mode: 'print' }));
    await vi.waitFor(() => expect(skip).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', reason: 'non-tui-mode' }),
    ));
  });

  it('reports skips without attempting completion', async () => {
    const complete = vi.fn();
    const skip = vi.fn();
    const host = { ...testHost(complete), reportSkip: skip };
    const handlers = install(createSessionTitleExtension(host), vi.fn());
    handlers.before({ prompt: 'Do work' }, context({ entries: [], currentModel: undefined }));
    await vi.waitFor(() => expect(skip).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', reason: 'model-unavailable' }),
    ));
    expect(complete).not.toHaveBeenCalled();
  });

  it('prefers the current low-tier model over a zero-cost medium-tier model', async () => {
    const complete = vi.fn().mockResolvedValue(response('Review session titles'));
    const currentModel = model('muse-spark-1.3-contributor-free', 0, 0);
    const host = testHost(complete, [model('big-pickle', 0, 0), currentModel]);
    const handlers = install(createSessionTitleExtension(host), vi.fn());

    handlers.before({ prompt: 'Review the session title behavior.' }, context({
      entries: [],
      currentModel,
    }));
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());

    expect(complete.mock.calls[0]?.[0].model.id).toBe('muse-spark-1.3-contributor-free');
  });

  it.each([
    ['existing name', { name: 'Manual name', entries: [] }, false],
    ['follow-up', { entries: [userEntry()] }, false],
    ['fork', { entries: [], parentSession: '/parent.jsonl' }, false],
    ['headless', { entries: [], mode: 'print' as const }, false],
  ])('does not generate for %s', async (_label, options, shouldCall) => {
    const complete = vi.fn();
    const handlers = install(createSessionTitleExtension(testHost(complete)), vi.fn(), options);
    handlers.before({ prompt: 'Do work' }, context(options));
    await Promise.resolve();
    expect(complete).toHaveBeenCalledTimes(shouldCall ? 1 : 0);
  });

  it('does not overwrite a manual name set while generation is running', async () => {
    let resolveCompletion!: (value: unknown) => void;
    const complete = vi.fn().mockReturnValue(new Promise((resolve) => { resolveCompletion = resolve; }));
    const setSessionName = vi.fn();
    const options: { name?: string } = {};
    const handlers = install(createSessionTitleExtension(testHost(complete)), setSessionName, options);
    const ctx = context({ entries: [] });
    handlers.before({ prompt: 'Do work' }, ctx);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    options.name = 'Manual name';
    resolveCompletion(response('Generated name'));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(setSessionName).not.toHaveBeenCalled();
  });

  it('notifies when the title request fails', async () => {
    const complete = vi.fn().mockRejectedValue(new Error('title model unavailable'));
    const notify = vi.fn();
    const host = testHost(complete);
    const handlers = install(createSessionTitleExtension(host), vi.fn());
    handlers.before({ prompt: 'Do work' }, context({ entries: [], notify }));
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(
      'Session title generation failed at complete: title model unavailable',
      'warning',
    ));
  });

  it('aborts and waits for pending work during shutdown', async () => {
    const complete = vi.fn().mockImplementation(({ options }: { options: { signal: AbortSignal } }) => (
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })
    ));
    const handlers = install(createSessionTitleExtension(testHost(complete)), vi.fn());
    handlers.before({ prompt: 'Do work' }, context({ entries: [] }));
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    await expect(handlers.shutdown()).resolves.toBeUndefined();
    expect(complete.mock.calls[0]?.[0].options.signal.aborted).toBe(true);
  });
});

function testHost(complete: ReturnType<typeof vi.fn>, models = [model('cheap', 1, 1)]): SessionTitleHost {
  return {
    prepare: vi.fn().mockImplementation(async (request) => request.mode === 'tui' && request.parentSession === undefined && request.currentModel
      ? { prompt: request.prompt, provider: request.currentModel.provider, models }
      : undefined),
    complete: complete as SessionTitleHost['complete'],
  };
}

function install(
  extension: ReturnType<typeof createSessionTitleExtension>,
  setSessionName: ReturnType<typeof vi.fn>,
  options: Partial<Parameters<typeof context>[0]> = {},
): { before: (event: { prompt: string }, ctx: ExtensionContext) => void; shutdown: () => Promise<void> } {
  let beforeHandler: ((event: { prompt: string }, ctx: ExtensionContext) => void) | undefined;
  let shutdownHandler: (() => Promise<void>) | undefined;
  const pi = {
    setSessionName,
    getSessionName: () => options.name,
    on: (event: string, handler: (...args: never[]) => unknown) => {
      if (event === 'before_agent_start') beforeHandler = handler as typeof beforeHandler;
      if (event === 'session_shutdown') shutdownHandler = handler as typeof shutdownHandler;
    },
  } as unknown as FelanExtensionAPI;
  extension(pi);
  return {
    before: (event, ctx) => beforeHandler?.(event, ctx),
    shutdown: async () => { await shutdownHandler?.(); },
  };
}

function context(options: {
  entries?: readonly SessionEntry[];
  mode?: ExtensionContext['mode'];
  parentSession?: string;
  name?: string;
  currentModel?: Model<any> | undefined;
  notify?: ReturnType<typeof vi.fn>;
}): ExtensionContext {
  return {
    mode: options.mode ?? 'tui',
    model: 'currentModel' in options ? options.currentModel : model('active', 5, 5),
    ui: { notify: options.notify ?? vi.fn() },
    sessionManager: {
      getSessionId: () => 'session-1',
      getEntries: () => [...options.entries ?? []],
      getHeader: () => options.parentSession === undefined ? { type: 'session', id: 'session-1', timestamp: '', cwd: '' } : { type: 'session', id: 'session-1', timestamp: '', cwd: '', parentSession: options.parentSession },
      getSessionName: () => options.name,
    },
  } as unknown as ExtensionContext;
}

function model(id: string, input: number, output: number, inputTypes: ('text' | 'image')[] = ['text']): Model<any> {
  return { id, provider: 'test', input: inputTypes, cost: { input, output, cacheRead: 0, cacheWrite: 0 } } as Model<any>;
}

function response(text: string): any {
  return { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' };
}

function userEntry(): SessionEntry {
  return { type: 'message', id: 'user', parentId: null, timestamp: '', message: { role: 'user', content: [], timestamp: 0 } } as SessionEntry;
}
