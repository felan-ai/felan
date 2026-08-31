import { describe, expect, it, vi } from 'vitest';
import { createInsightsExtension } from '../src/index.js';

describe('createInsightsExtension', () => {
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
});
