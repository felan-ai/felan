import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { fuzzyFilter } from '@earendil-works/pi-tui';
import { limitedPrompts } from '../src/history.js';
import { splitPromptHistoryText } from '../src/text.js';

describe('prompt history transport', () => {
  it('transfers long multiline Unicode prompts without truncation or oversized encoded chunks', () => {
    const text = '😀\n"\\needle'.repeat(30000); const encoded = splitPromptHistoryText(text);
    expect(encoded.chunks.length).toBeGreaterThan(3); expect(encoded.chunks.join('')).toBe(text);
    expect(encoded.bytes).toBe(Buffer.byteLength(text));
    for (const part of encoded.chunks) expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThanOrEqual(24 * 1024);
  });
  it('preserves the pinned fuzzy ranking without loading its TUI entrypoint', async () => {
    const items = ['foo 12', '12foo', 'foo/bar.ts', 'farboo', 'FOO 12'].map((text, index) => ({ id: String(index), text, cwd: '/w', sessionLabel: 's', timestamp: index }));
    for (const query of ['f12', '12f', 'foo', 'foo bar', '/foo/', '']) {
      const sorted = [...items].sort((a, b) => b.timestamp - a.timestamp);
      expect(limitedPrompts(items, query)).toEqual(fuzzyFilter(sorted, query, item => `${item.text} ${item.cwd} `));
    }
    const source = await readFile(new URL('../src/history.ts', import.meta.url), 'utf8');
    expect(source).toContain('@earendil-works/pi-tui');
    expect(await readFile(new URL('../../../apps/felan/src/tui/renderers/prompt-history/picker.ts', import.meta.url), 'utf8')).not.toContain('./history.js');
    expect(await readFile(new URL('../../../apps/felan/src/tui/renderers/prompt-history.ts', import.meta.url), 'utf8')).not.toContain('./history.js');
  });
});
