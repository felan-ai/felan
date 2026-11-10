import { describe, expect, it } from 'vitest';
import type { MemoryHistorySnapshot } from '../../src/local/history.js';
import { memoryTranscriptPages } from '../../src/local/transcript-pages.js';

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } };

function snapshot(messages: unknown[]): MemoryHistorySnapshot {
  return {
    session: { id: 'run', path: '/sessions/memory/run.jsonl', cwd: '/project', created: new Date(), modified: new Date(),
      messageCount: messages.length, firstMessage: '', allMessagesText: '',
      memory: { project: { canonicalRoot: '/project', key: 'k' }, manifestPath: '/agent/manifest.json' } },
    metadata: { version: 1, kind: 'memory', sessionId: 'run', sessionFile: 'run.jsonl', projectKey: 'k', projectRoot: '/project',
      startedAt: '2026-11-10T00:00:00.000Z', status: 'failed', phase: 'model', checkpoints: [], baseFingerprint: '0',
      model: { provider: 'openai', id: 'gpt' }, error: 'Token expired' },
    messages: messages as MemoryHistorySnapshot['messages'],
    diagnostics: [],
  };
}

function exchange(index: number, output: string): unknown[] {
  return [
    { role: 'assistant', content: [{ type: 'text', text: `Reading ${index}` }, { type: 'toolCall', id: `call-${index}`, name: 'read', arguments: { path: `f${index}` } }],
      provider: 'openai', model: 'gpt', api: 'openai-responses', stopReason: 'toolUse', usage, timestamp: 1 },
    { role: 'toolResult', toolCallId: `call-${index}`, toolName: 'read', content: [{ type: 'text', text: output }], isError: false, timestamp: 1 },
  ];
}

describe('memory transcript pages', () => {
  it('carries structured messages and a readable fallback instead of JSON', () => {
    const pages = memoryTranscriptPages(snapshot([
      { role: 'user', content: [{ type: 'text', text: 'Update *memory* <now>' }], timestamp: 1 }, ...exchange(1, 'file body'),
    ]));

    expect(pages).toHaveLength(1);
    expect(pages[0]!.data.transcript).toMatchObject({ cwd: '/project', page: 1, pages: 1,
      details: expect.arrayContaining(['Model: openai/gpt', 'Error: Token expired']) });
    expect(pages[0]!.data.transcript.messages.map(message => message.role)).toEqual(['user', 'assistant', 'toolResult']);
    expect(pages[0]!.markdown).toContain('### User\n\nUpdate \\*memory\\* &lt;now&gt;');
    expect(pages[0]!.markdown).toContain('Tool call: read');
    expect(pages[0]!.markdown).toContain('### Tool result: read');
    expect(pages[0]!.markdown).not.toContain('"role"');
  });

  it('keeps every page under the UI hint limit and tool calls beside their results', () => {
    const messages = Array.from({ length: 40 }, (_, index) => exchange(index, 'x'.repeat(6_000))).flat();
    messages.push(...exchange(99, 'y'.repeat(2_000_000)));

    const pages = memoryTranscriptPages(snapshot(messages));

    expect(pages.length).toBeGreaterThan(1);
    for (const [index, page] of pages.entries()) {
      expect(Buffer.byteLength(JSON.stringify(page.data))).toBeLessThan(128 * 1024);
      expect(page.data.transcript).toMatchObject({ page: index + 1, pages: pages.length });
      expect(page.data.transcript.messages[0]!.role).toBe('assistant');
    }
    expect(pages.flatMap(page => page.data.transcript.messages)).toHaveLength(messages.length);
    expect(JSON.stringify(pages.at(-1)!.data)).toContain('characters truncated for display');
  });
});
