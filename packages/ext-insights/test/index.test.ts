import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSIONS_HISTORY_SERVICE, SessionsServiceError, createExtensionServiceAccess, createFelanServiceRegistry, type FelanExtensionAPI, type SessionsHistory } from '@felan-ai/agent-core';
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

  it('writes the branded report filename', async () => {
    let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
    let fileName = '';
    const transcript = [
      JSON.stringify({ type: 'session', id: 'session-1', cwd: '/workspace/felan', timestamp: '2026-08-29T07:00:00Z' }),
      JSON.stringify({ type: 'message', timestamp: '2026-08-29T07:01:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
    ].join('\n');
    const runtime = {
      storage: () => ({ root: '/agent-storage', readFile: vi.fn().mockRejectedValue(new Error('miss')), writeFile: vi.fn(), listFiles: vi.fn(), mkdir: vi.fn(), remove: vi.fn() }),
    };
    createInsightsExtension({
      listSessions: async () => [{ id: 'session-1', path: '/session.jsonl', size: transcript.length, modifiedAtMs: 1 }],
      readSession: async () => transcript,
      writeReport: async (_runtime, name) => { fileName = name; return `/reports/${name}`; },
    })({ runtime, registerCommand: (_name: string, definition: typeof command) => { command = definition; } } as never);

    await command!.handler('--no-open', { ui: { notify: vi.fn() } });
    expect(fileName).toBe('felan-insights.html');
  });

  it('forwards runtime and cancellation to the provider and prefers streaming transcripts', async () => {
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
      writeReport: vi.fn(async () => '/reports/insights.html'),
      writeMarkdown: vi.fn(async () => '/reports/insights.md'),
      presentReport: vi.fn(async () => {}),
    };
    createInsightsExtension(host)({ runtime, registerCommand: (_name: string, definition: typeof command) => { command = definition; } } as never);
    const signal = new AbortController().signal;
    await command!.handler('--md', { ui: { notify: vi.fn() }, signal });
    expect(host.listSessions).toHaveBeenCalledExactlyOnceWith(runtime, signal);
    expect(host.readSessionLines).toHaveBeenCalledExactlyOnceWith(runtime, reference, signal);
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
    expect(data.cache.versions).toEqual({ schema: '2', parser: '2' });
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
    expect(h.sessions.history).toHaveBeenCalledWith('root', expect.objectContaining({ at: { sessionId: 'root', revision: 'journal', branch: 'user' } }));
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

  it('names the service failure when the session listing itself cannot be read', async () => {
    const h = defaultFixture();
    h.sessions.list.mockRejectedValue(new SessionsServiceError('inaccessible'));
    await h.command()('', h.context);
    expect(h.notify).toHaveBeenLastCalledWith({ level: 'error', text: 'Could not list sessions (inaccessible).' });
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
