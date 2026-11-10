import { afterEach, describe, expect, it, vi } from 'vitest';
import { availableParallelism } from 'node:os';
import { SESSIONS_HISTORY_SERVICE, SessionsServiceError, createExtensionServiceAccess, createFelanServiceRegistry, type FelanExtensionAPI, type SessionsHistory, type UiStatus } from '@felan-ai/agent-core';
import insightsExtension, { createInsightsExtension, type InsightsHost } from '../src/extension.js';

describe('service-backed insights extension', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('requires a configured session service before registering commands', () => {
    expect(insightsExtension.serviceRequirements).toEqual({ required: [SESSIONS_HISTORY_SERVICE] });
    const registerCommand = vi.fn();
    const services = createExtensionServiceAccess(createFelanServiceRegistry(), insightsExtension.serviceRequirements!);
    expect(() => insightsExtension({ services, registerCommand } as unknown as FelanExtensionAPI))
      .toThrow(`Required service ${SESSIONS_HISTORY_SERVICE.key} has no configured provider.`);
    expect(registerCommand).not.toHaveBeenCalled();
  });

  it('registers the bounded insights command and reports an empty range', async () => {
    let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
    const notify = vi.fn();
    const runtime = {
      storage: () => ({ root: '/agent-storage', readFile: vi.fn(), writeFile: vi.fn(), listFiles: vi.fn(), mkdir: vi.fn(), remove: vi.fn() }),
    };
    createInsightsExtension({
      listSessions: async () => [],
      readSession: async () => undefined,
      writeReport: async () => 'report.html',
    })({
      runtime,
      registerCommand: (_name: string, definition: typeof command) => { command = definition; },
    } as never);

    await command!.handler('', { ui: { notify } });
    expect(notify).toHaveBeenCalledWith('No valid sessions found for the selected range.', 'warning');
  });

  it.each(['entries', 'lines'] as const)('forwards runtime and cancellation to the provider and prefers %s', async method => {
    let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
    const transcript = [
      JSON.stringify({ type: 'session', id: 'root', cwd: '/workspace', timestamp: '2026-08-29T07:00:00Z' }),
      JSON.stringify({ type: 'message', timestamp: '2026-08-29T07:01:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
    ];
    const reference = { id: 'root', path: '/root.jsonl', size: transcript.join('\n').length, modifiedAtMs: 1 };
    const runtime = {
      storage: () => ({ root: '/agent', readFile: vi.fn().mockRejectedValue(new Error('miss')), writeFile: vi.fn(), mkdir: vi.fn() }),
    };
    const host: InsightsHost = {
      listSessions: vi.fn(async () => [reference]),
      readSession: vi.fn(),
      readSessionLines: vi.fn(async function* () { yield* transcript; }),
      ...(method === 'entries' ? { readSessionEntries: vi.fn(async () => transcript.map(line => JSON.parse(line))) } : {}),
      writeReport: vi.fn(async () => '/reports/insights.html'),
      writeMarkdown: vi.fn(async () => '/reports/insights.md'),
      presentReport: vi.fn(async () => {}),
    };
    createInsightsExtension(host)({ runtime, registerCommand: (_name: string, definition: typeof command) => { command = definition; } } as never);
    const signal = new AbortController().signal;
    await command!.handler('--md', { ui: { notify: vi.fn() }, signal });
    expect(host.listSessions).toHaveBeenCalledExactlyOnceWith(runtime, signal);
    if (method === 'entries') {
      expect(host.readSessionEntries).toHaveBeenCalledExactlyOnceWith(runtime, reference, signal);
      expect(host.readSessionLines).not.toHaveBeenCalled();
    } else expect(host.readSessionLines).toHaveBeenCalledExactlyOnceWith(runtime, reference, signal);
    expect(host.readSession).not.toHaveBeenCalled();
    expect(host.writeReport).toHaveBeenCalledWith(runtime, 'felan-insights.html', expect.any(String));
    expect(host.writeMarkdown).toHaveBeenCalledWith(runtime, 'felan-insights.md', expect.any(String));
    expect(host.presentReport).toHaveBeenCalledExactlyOnceWith(runtime, expect.objectContaining({
      path: '/reports/insights.html', initialRange: '30d', loaded: [expect.objectContaining({ rootId: 'root' })],
    }), signal);
  });

  it('writes the HTML report without presenting the dashboard when --no-open is given', async () => {
    let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
    const transcript = [
      JSON.stringify({ type: 'session', id: 'root', cwd: '/workspace', timestamp: '2026-08-29T07:00:00Z' }),
      JSON.stringify({ type: 'message', timestamp: '2026-08-29T07:01:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
    ].join('\n');
    const runtime = { storage: () => ({ root: '/agent', readFile: vi.fn().mockRejectedValue(new Error('miss')), writeFile: vi.fn(), mkdir: vi.fn() }) };
    const host: InsightsHost = {
      listSessions: async () => [{ id: 'root', path: '/root.jsonl', size: transcript.length, modifiedAtMs: 1 }],
      readSession: async () => transcript,
      writeReport: vi.fn(async () => '/reports/insights.html'),
      presentReport: vi.fn(async () => {}),
    };
    createInsightsExtension(host)({ runtime, registerCommand: (_name: string, definition: typeof command) => { command = definition; } } as never);
    await command!.handler('--no-open', { ui: { notify: vi.fn() } });
    expect(host.writeReport).toHaveBeenCalledOnce();
    expect(host.presentReport).not.toHaveBeenCalled();
  });

  it('counts turns from resumed roots and retained agents inside --since', async () => {
    // --since resolves against the wall clock, so pin it to keep the fixture timestamps in range.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-01T12:00:00Z'));
    let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
    let report = '';
    let cache = '';
    const rootTranscript = [
      JSON.stringify({ type: 'session', id: 'root', cwd: '/workspace/bench', timestamp: '2026-08-29T00:00:00Z' }),
      JSON.stringify({ type: 'message', timestamp: '2026-08-29T23:59:00Z', message: { role: 'assistant', model: 'model', content: [], usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 10 } } } }),
      JSON.stringify({ type: 'message', timestamp: '2026-08-31T00:01:00Z', message: { role: 'assistant', model: 'model', content: [], usage: { input: 2, output: 2, totalTokens: 4, cost: { total: 20 } } } }),
    ].join('\n');
    const childTranscript = [
      JSON.stringify({ type: 'session', id: 'child', cwd: '/workspace/bench', timestamp: '2026-08-31T00:02:00Z' }),
      JSON.stringify({ type: 'message', timestamp: '2026-08-31T00:03:00Z', message: { role: 'assistant', model: 'model', content: [], usage: { input: 3, output: 3, totalTokens: 6, cost: { total: 30 } } } }),
    ].join('\n');
    const runtime = {
      storage: () => ({ root: '/agent-storage', readFile: vi.fn().mockRejectedValue(new Error('miss')), writeFile: vi.fn((_path: string, bytes: Uint8Array) => { cache = new TextDecoder().decode(bytes); }), listFiles: vi.fn(), mkdir: vi.fn(), remove: vi.fn() }),
    };
    createInsightsExtension({
      listSessions: async () => [
        { id: 'root', path: '/root.jsonl', size: rootTranscript.length, modifiedAtMs: 1 },
        { id: 'child', path: '/child.jsonl', size: childTranscript.length, modifiedAtMs: 1, rootSessionId: 'root', isAgent: true },
      ],
      readSession: async (_runtime, reference) => reference.id === 'root' ? rootTranscript : childTranscript,
      writeReport: async (_runtime, _name, content) => { report = content; return 'report.html'; },
    })({ runtime, registerCommand: (_name: string, definition: typeof command) => { command = definition; } } as never);

    await command!.handler('--no-open --since 2d', { ui: { notify: vi.fn() } });
    const marker = 'window.__FELAN_INSIGHTS_DATA__=';
    const dataStart = report.indexOf(marker) + marker.length;
    const dataEnd = report.indexOf(';</script>', dataStart);
    const data = JSON.parse(report.slice(dataStart, dataEnd));
    expect(data.totalSessions).toBe(1);
    expect(data.totalCost).toBe(50);
    expect(data.sessions[0].agentSessionCount).toBe(2);
    expect(data.cache.versions).toEqual({ schema: '2', parser: '3' });
    expect(cache).toContain('"activity"');
    expect(data.export.outputFormats).toEqual(['html']);
  });
});

describe('shared Sessions default', () => {
  it('publishes generic notifications and reads shared history without native UI or feature services', async () => {
    const h = defaultFixture();
    const entry = { type: 'message', id: 'user', parentId: null, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } };
    h.sessions.list.mockResolvedValue({ items: [{ id: 'root', root: 'root', cwd: '/project', title: 'Root', updatedAt: 1, state: 'open' }] });
    h.sessions.history.mockResolvedValue({ sessionId: 'root', revision: 'journal', branch: 'user', entries: [entry] as never });
    await h.command()('--no-open', h.context);
    expect(h.sessions.history).toHaveBeenCalledExactlyOnceWith('root', expect.objectContaining({ limit: expect.any(Number) }));
    expect(h.sessions.checkpoint).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ level: 'info', text: expect.stringContaining('Insights report ready:') }));
    expect(h.writeFile).toHaveBeenCalledWith('insights-reports/felan-insights.html', expect.any(Uint8Array));
    await h.shutdown();
  });

  it('reports sessions it could not read and still builds the report from the rest', async () => {
    const h = defaultFixture();
    const entry = { type: 'message', id: 'user', parentId: null, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } };
    const info = { cwd: '/project', title: 'Session', updatedAt: 1, state: 'open' as const };
    h.sessions.list.mockResolvedValue({ items: [
      { ...info, id: 'root', root: 'root' }, { ...info, id: 'missing', root: 'missing', diagnostic: 'inaccessible' }, { ...info, id: 'busy', root: 'busy' },
    ] });
    h.sessions.checkpoint.mockImplementation(async id => ({ sessionId: id, revision: 'journal', branch: 'user', byteLength: 1000, transcriptDigest: 'digest' }));
    h.sessions.history.mockImplementation(async id => {
      if (id === 'busy') throw new SessionsServiceError('stale');
      return { sessionId: id, revision: 'journal', branch: 'user', entries: [entry] as never };
    });
    await h.command()('--no-open', h.context);
    expect(h.notify).toHaveBeenCalledWith({ level: 'warning', text: 'Skipped 2 of 3 sessions that could not be read (inaccessible 1, stale 1).' });
    expect(h.writeFile).toHaveBeenCalledWith('insights-reports/felan-insights.html', expect.any(Uint8Array));
    await h.shutdown();
  });

  it.each(['inaccessible', 'oversize'] as const)('names %s when the session listing itself cannot be read', async code => {
    const h = defaultFixture();
    h.sessions.list.mockRejectedValue(new SessionsServiceError(code));
    await h.command()('', h.context);
    expect(h.notify).toHaveBeenLastCalledWith({ level: 'error', text: `Could not list sessions (${code}).` });
    expect(h.writeFile).not.toHaveBeenCalled();
    await h.shutdown();
  });

  it('stops with one warning when the calling session becomes unavailable while listing', async () => {
    const h = defaultFixture();
    h.sessions.list.mockRejectedValue(new SessionsServiceError('unavailable'));
    await h.command()('', h.context);
    expect(h.notify).toHaveBeenLastCalledWith({ level: 'warning', text: 'Insights stopped because this session is cancelling or closing.' });
    expect(h.notify).not.toHaveBeenCalledWith(expect.objectContaining({ level: 'error' }));
    expect(h.writeFile).not.toHaveBeenCalled();
    await h.shutdown();
  });

  it('aborts and joins an active command before disposing its shared-service scope', async () => {
    const h = defaultFixture();
    let release!: () => void;
    const entered = new Promise<void>(resolve => {
      h.sessions.list.mockImplementationOnce(async () => { resolve(); await new Promise<void>(done => { release = done; }); return { items: [] }; });
    });
    const running = expect(h.command()('', h.context)).rejects.toMatchObject({ name: 'AbortError' });
    await entered;
    let stopped = false;
    const stopping = h.shutdown().then(() => { stopped = true; });
    expect(h.sessions.list.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(stopped).toBe(false);
    release();
    await running; await stopping;
    expect(h.writeFile).not.toHaveBeenCalled();
  });
});

describe('incremental transcript bounds', () => {
  it('stops and closes a streaming source before collecting more than 64 MiB', async () => {
    let handler!: (args: string, ctx: unknown) => Promise<void>;
    let pulls = 0;
    let closed = false;
    const line = 'x'.repeat(1024 * 1024);
    const writeReport = vi.fn(async () => 'unused');
    const notify = vi.fn();
    createInsightsExtension({
      listSessions: async () => [{ id: 'large', path: 'large', modifiedAtMs: 1 }], readSession: async () => undefined,
      readSessionLines: async function* () { try { for (let i = 0; i < 100; i++) { pulls++; yield line; } } finally { closed = true; } },
      writeReport,
    })({ runtime: { storage: () => ({ readFile: async () => { throw new Error('miss'); } }) }, registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; } } as never);
    await handler('--no-open', { ui: { notify } });
    expect(notify).toHaveBeenCalledWith('Skipped 1 of 1 sessions that could not be read (oversize 1).', 'warning');
    expect(pulls).toBeLessThanOrEqual(64);
    expect(closed).toBe(true);
    expect(writeReport).not.toHaveBeenCalled();
  });

  it('closes a stream on cancellation without asking for another line', async () => {
    let handler!: (args: string, ctx: unknown) => Promise<void>;
    const controller = new AbortController();
    let pulls = 0;
    let closed = false;
    createInsightsExtension({
      listSessions: async () => [{ id: 'cancel', path: 'cancel', modifiedAtMs: 1 }], readSession: async () => undefined,
      readSessionLines: async function* () { try { pulls++; controller.abort(); yield 'cancelled'; pulls++; yield 'must not be read'; } finally { closed = true; } },
      writeReport: async () => 'unused',
    })({ runtime: { storage: () => ({ readFile: async () => { throw new Error('miss'); } }) }, registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; } } as never);
    await expect(handler('--no-open', { signal: controller.signal, ui: { notify: vi.fn() } })).rejects.toMatchObject({ name: 'AbortError' });
    expect(pulls).toBe(1);
    expect(closed).toBe(true);
  });
});

function defaultFixture() {
  const registry = createFelanServiceRegistry();
  const sessions = {
    current: { id: 'root', root: 'root' },
    list: vi.fn<SessionsHistory['list']>().mockResolvedValue({ items: [] }),
    checkpoint: vi.fn<SessionsHistory['checkpoint']>().mockResolvedValue({ sessionId: 'root', revision: 'journal', branch: 'user', byteLength: 1000, transcriptDigest: 'digest' }),
    history: vi.fn<SessionsHistory['history']>().mockResolvedValue({ sessionId: 'root', revision: 'journal', branch: 'user', entries: [] }),
  } satisfies SessionsHistory;
  registry.set(SESSIONS_HISTORY_SERVICE, sessions);
  const handlers: Array<() => Promise<void>> = [];
  let command!: (args: string, ctx: unknown) => Promise<void>;
  const notify = vi.fn(async () => {});
  const writeFile = vi.fn(async () => {});
  insightsExtension({
    services: createExtensionServiceAccess(registry, insightsExtension.serviceRequirements!),
    runtime: { storage: () => ({ root: '/agent', mkdir: async () => {}, readFile: async () => { throw new Error('miss'); }, writeFile }) },
    ui: { notify },
    registerCommand: (_name: string, definition: { handler: typeof command }) => { command = definition.handler; },
    on: (_name: string, handler: () => Promise<void>) => { handlers.push(handler); },
  } as unknown as FelanExtensionAPI);
  return { sessions, notify, writeFile, command: () => command,
    context: { get ui() { throw new Error('Native UI must not be used'); } },
    async shutdown() { for (const handler of handlers) await handler(); },
  };
}

describe('session scan', () => {
  function storedFixture(count: number) {
    const registry = createFelanServiceRegistry();
    const files = new Map<string, Uint8Array>();
    const ids = Array.from({ length: count }, (_, index) => `s${index}`);
    const entry = { type: 'message', id: 'user', parentId: null, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } };
    const sessions = {
      current: { id: 'root', root: 'root' },
      list: vi.fn<SessionsHistory['list']>(async () => ({ items: ids.map(id => ({ id, root: id, cwd: '/project', title: id, updatedAt: 1, state: 'closed' as const })) })),
      checkpoint: vi.fn<SessionsHistory['checkpoint']>(),
      history: vi.fn<SessionsHistory['history']>(async id => ({ sessionId: id, revision: 'journal', branch: 'user', entries: [entry] as never })),
    } satisfies SessionsHistory;
    registry.set(SESSIONS_HISTORY_SERVICE, sessions);
    const storage = {
      root: '/agent',
      mkdir: async () => {},
      readFile: async (path: string) => { const file = files.get(path); if (!file) throw new Error('missing'); return file; },
      writeFile: async (path: string, content: Uint8Array) => { files.set(path, content); },
      listFiles: async (path: string) => [...files.keys()].filter(key => key.startsWith(`${path}/`)).map(key => key.slice(path.length + 1)).filter(name => !name.includes('/')),
      remove: vi.fn(async (path: string) => { files.delete(path); }),
    };
    const ui = { notify: vi.fn(async (_message: { level: string; text: string }) => {}), status: vi.fn(async (_item: UiStatus) => {}), removeStatus: vi.fn(async (_id: string) => {}) };
    let command!: (args: string, ctx: unknown) => Promise<void>;
    const handlers: Array<() => Promise<void>> = [];
    insightsExtension({
      services: createExtensionServiceAccess(registry, insightsExtension.serviceRequirements!),
      runtime: { storage: () => storage }, ui,
      registerCommand: (_name: string, definition: { handler: typeof command }) => { command = definition.handler; },
      on: (_name: string, handler: () => Promise<void>) => { handlers.push(handler); },
    } as unknown as FelanExtensionAPI);
    return { sessions, files, ids, storage, ui, run: (args = '--no-open', signal?: AbortSignal) => command(args, signal ? { signal } : {}),
      cacheFiles: () => [...files.keys()].filter(key => key.startsWith('insights/session-meta/')),
      async shutdown() { for (const handler of handlers) await handler(); } };
  }

  it('reads cold sessions through history only and serves a warm scan entirely from the cache', async () => {
    const h = storedFixture(5);
    await h.run();
    expect(h.sessions.checkpoint).not.toHaveBeenCalled();
    expect(h.sessions.history).toHaveBeenCalledTimes(5);
    expect(h.cacheFiles()).toHaveLength(5);
    h.sessions.history.mockClear();
    await h.run();
    expect(h.sessions.checkpoint).not.toHaveBeenCalled();
    expect(h.sessions.history).not.toHaveBeenCalled();
    const report = new TextDecoder().decode(h.files.get('insights-reports/felan-insights.html'));
    expect(report).toContain('"sessionMeta":{"hits":5,"misses":0,"writes":0,"errors":0}');
    await h.shutdown();
  });

  it('shows scanning progress while sessions load and removes it at the end', async () => {
    const h = storedFixture(3);
    await h.run();
    const texts = h.ui.status.mock.calls.map(([item]) => item.value.kind === 'text' ? item.value.text : '');
    expect(texts).toEqual(['Insights: scanning sessions 0/3', 'Insights: scanning sessions 1/3', 'Insights: scanning sessions 2/3', 'Insights: scanning sessions 3/3']);
    expect(h.ui.status.mock.calls[0]![0]).toMatchObject({ id: 'insights', kind: 'status', key: 'insights' });
    expect(h.ui.removeStatus).toHaveBeenCalledExactlyOnceWith('insights');
    expect(h.ui.removeStatus.mock.invocationCallOrder[0]).toBeGreaterThan(h.ui.status.mock.invocationCallOrder.at(-1)!);
    await h.shutdown();
  });

  it('prunes cache files that no listed session references after a complete scan', async () => {
    const h = storedFixture(3);
    await h.run();
    const orphan = `insights/session-meta/${'a'.repeat(64)}.json`;
    h.files.set(orphan, new Uint8Array());
    h.files.set('insights/session-meta/notes.txt', new Uint8Array());
    h.files.set('insights-reports/other.json', new Uint8Array());
    h.ids.pop();
    await h.run();
    expect(h.files.has(orphan)).toBe(false);
    expect(h.files.has('insights/session-meta/notes.txt')).toBe(true);
    expect(h.files.has('insights-reports/other.json')).toBe(true);
    expect(h.cacheFiles().filter(name => name.endsWith('.json'))).toHaveLength(2);
    expect(h.storage.remove.mock.calls.every(([path]) => path.startsWith('insights/session-meta/'))).toBe(true);
    await h.shutdown();
  });

  it('removes the progress status and keeps the cache when a scan is cancelled', async () => {
    const h = storedFixture(2);
    await h.run();
    const orphan = `insights/session-meta/${'b'.repeat(64)}.json`;
    h.files.set(orphan, new Uint8Array());
    h.ui.removeStatus.mockClear();
    const controller = new AbortController();
    h.sessions.history.mockImplementation(async () => { controller.abort(); throw new SessionsServiceError('inaccessible'); });
    await expect(h.run('--no-open --refresh', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.ui.removeStatus).toHaveBeenCalledExactlyOnceWith('insights');
    expect(h.files.has(orphan)).toBe(true);
    await h.shutdown();
  });

  it.each([false, true])('stops after an unavailable read, including when its warning fails: %s', async failWarning => {
    const concurrency = availableParallelism();
    const h = storedFixture(concurrency + 3);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let startedReads = 0;
    h.sessions.history.mockImplementation(async id => {
      if (++startedReads === concurrency) entered();
      if (id === 's0') throw new SessionsServiceError('unavailable');
      await pending;
      return { sessionId: id, revision: 'journal', branch: null, entries: [] };
    });
    if (failWarning) h.ui.notify.mockImplementation(async message => {
      if (message.level === 'warning') throw new Error('Notification unavailable.');
    });
    const orphan = `insights/session-meta/${'c'.repeat(64)}.json`;
    h.files.set(orphan, new Uint8Array());
    const running = h.run();
    await started;
    release();
    await expect(running).resolves.toBeUndefined();
    expect(h.sessions.history.mock.calls.map(([id]) => id)).toEqual(h.ids.slice(0, concurrency));
    expect(h.ui.notify.mock.calls.filter(([message]) => message.level === 'warning')).toEqual([
      [{ level: 'warning', text: 'Insights stopped because this session is cancelling or closing.' }],
    ]);
    expect(h.files.has('insights-reports/felan-insights.html')).toBe(false);
    expect(h.files.has(orphan)).toBe(true);
    expect(h.ui.removeStatus).toHaveBeenCalledExactlyOnceWith('insights');
    await h.shutdown();
  });

  it('counts unparseable transcripts in the skipped notice', async () => {
    const h = storedFixture(2);
    h.sessions.history.mockImplementation(async id => ({ sessionId: id, revision: 'journal', branch: 'user',
      entries: [id === 's1' ? { type: 'message', id: 'user', parentId: null, message: { role: 'user', content: [] } } : {
        type: 'message', id: 'user', parentId: null, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }] as never }));
    await h.run();
    expect(h.ui.notify).toHaveBeenCalledWith({ level: 'warning', text: 'Skipped 1 of 2 sessions that could not be read (unparseable 1).' });
    await h.shutdown();
  });

  it('counts entries that a fork or clone copied from its parent once', async () => {
    const h = storedFixture(2);
    const message = (id: string, timestamp: string, role: 'user' | 'assistant') => ({ type: 'message', id, parentId: null, timestamp,
      message: role === 'user' ? { role, content: [{ type: 'text', text: 'hello' }] } : { role, model: 'm', content: [], usage: { input: 1, output: 1, cost: { total: 1 } } } });
    const parent = [message('u1', '2026-01-01T10:00:00Z', 'user'), message('a1', '2026-01-01T10:01:00Z', 'assistant')];
    h.sessions.history.mockImplementation(async id => id === 's0'
      ? { sessionId: id, revision: 'journal', branch: 'a1', startedAt: '2026-01-01T09:59:00Z', entries: parent as never }
      : { sessionId: id, revision: 'journal', branch: 'a2', startedAt: '2026-01-02T08:00:00Z',
        entries: [...parent, message('u2', '2026-01-02T08:01:00Z', 'user'), message('a2', '2026-01-02T08:02:00Z', 'assistant')] as never });
    await h.run();
    const report = new TextDecoder().decode(h.files.get('insights-reports/felan-insights.html'));
    const marker = 'window.__FELAN_INSIGHTS_DATA__=';
    const start = report.indexOf(marker) + marker.length;
    const data = JSON.parse(report.slice(start, report.indexOf(';</script>', start)));
    expect(data.totalSessions).toBe(2);
    expect(data.totalMessages).toBe(4);
    expect(data.totalCost).toBe(2);
    expect(data.modelStats).toEqual([expect.objectContaining({ name: 'm', count: 2 })]);
    await h.shutdown();
  });
});
