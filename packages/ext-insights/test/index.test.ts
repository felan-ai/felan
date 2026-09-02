import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInsightsExtension } from '../src/index.js';

describe('createInsightsExtension', () => {
  afterEach(() => { vi.useRealTimers(); });

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
    expect(cache).toContain('"activity"');
    expect(data.export.outputFormats).toEqual(['html']);
  });
});
