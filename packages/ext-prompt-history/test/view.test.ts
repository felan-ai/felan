import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { fuzzyFilter } from '@earendil-works/pi-tui';
import { limitedPrompts } from '../src/history.js';
import { parsePromptHistoryAction, parsePromptHistoryFrame, parsePromptHistoryRequest, parsePromptHistoryText, splitPromptHistoryText } from '../src/view.js';

describe('prompt history transport', () => {
  const browse = parsePromptHistoryRequest({ viewId: 'view', generation: 1, kind: 'browse', scope: 'session', query: '', displayMode: 'inline' });
  it('rejects stale, cross-stage and extra-field actions', () => {
    expect(parsePromptHistoryAction({ viewId: 'view', generation: 1, action: 'search', scope: 'all', query: 'needle' }, browse)).toMatchObject({ scope: 'all' });
    for (const extra of [{ generation: 2 }, { viewId: 'other' }, { text: 'forged prompt' }, { action: 'insert' }, { action: 'chunk', index: 0 }]) {
      expect(() => parsePromptHistoryAction({ viewId: 'view', generation: 1, action: 'choose', id: 'item', ...extra }, browse)).toThrow();
    }
    const transfer = parsePromptHistoryRequest({ viewId: 'view', generation: 2, kind: 'text', index: 0, chunks: 2, bytes: 5 });
    expect(() => parsePromptHistoryAction({ viewId: 'view', generation: 2, action: 'insert' }, transfer)).toThrow();
  });
  it('transfers long multiline Unicode prompts without truncation or oversized encoded chunks', () => {
    const text = '😀\n"\\needle'.repeat(30000); const encoded = splitPromptHistoryText(text);
    expect(encoded.chunks.length).toBeGreaterThan(3); expect(encoded.chunks.join('')).toBe(text);
    expect(encoded.bytes).toBe(Buffer.byteLength(text));
    for (const [index, part] of encoded.chunks.entries()) expect(parsePromptHistoryText({ viewId: 'view', generation: 1, index, text: part }).text).toBe(part);
    expect(() => parsePromptHistoryText({ viewId: 'view', generation: 1, index: 0, text: '\n'.repeat(24000) })).toThrow();
  });
  it('bounds and validates preview frames', () => {
    const frame = { viewId: 'view', generation: 1, version: 1, items: [], scanned: 0, loading: false, complete: true };
    expect(parsePromptHistoryFrame(frame).items).toEqual([]);
    expect(() => parsePromptHistoryFrame({ ...frame, total: -1 })).toThrow();
    expect(() => parsePromptHistoryFrame({ ...frame, unexpected: true })).toThrow();
  });
  it('preserves the pinned fuzzy ranking without loading its TUI entrypoint', async () => {
    const items = ['foo 12', '12foo', 'foo/bar.ts', 'farboo', 'FOO 12'].map((text, index) => ({ id: String(index), text, cwd: '/w', sessionLabel: 's', timestamp: index }));
    for (const query of ['f12', '12f', 'foo', 'foo bar', '/foo/', '']) {
      const sorted = [...items].sort((a, b) => b.timestamp - a.timestamp);
      expect(limitedPrompts(items, query)).toEqual(fuzzyFilter(sorted, query, item => `${item.text} ${item.cwd} `));
    }
    const source = await readFile(new URL('../src/history.ts', import.meta.url), 'utf8');
    expect(source).toContain('@earendil-works/pi-tui/dist/fuzzy.js');
    expect(await readFile(new URL('../src/picker.ts', import.meta.url), 'utf8')).not.toContain('./history.js');
    expect(await readFile(new URL('../src/tui.ts', import.meta.url), 'utf8')).not.toContain('./history.js');
  });
});
