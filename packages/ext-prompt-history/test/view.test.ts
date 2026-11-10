import { describe, expect, it } from 'vitest';
import { splitPromptHistoryText } from '../src/text.js';

describe('prompt history transport', () => {
  it('transfers long multiline Unicode prompts without truncation or oversized encoded chunks', () => {
    const text = '😀\n"\\needle'.repeat(30000); const encoded = splitPromptHistoryText(text);
    expect(encoded.chunks.length).toBeGreaterThan(3); expect(encoded.chunks.join('')).toBe(text);
    expect(encoded.bytes).toBe(Buffer.byteLength(text));
    for (const part of encoded.chunks) expect(Buffer.byteLength(JSON.stringify(part))).toBeLessThanOrEqual(24 * 1024);
  });
});
