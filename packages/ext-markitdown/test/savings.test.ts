import { describe, expect, it, vi } from 'vitest';
import { reportMarkitdownSavings } from '../src/savings.js';

describe('MarkItDown savings', () => {
  it('uses the current prompt-token benchmark ratio for the converted text boundary', () => {
    const report = vi.fn(async () => undefined);

    reportMarkitdownSavings(
      { report },
      { provider: 'test', id: 'model' },
      'read',
      [{ type: 'text', text: 'a'.repeat(68) }],
    );

    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      baseline: { model: { provider: 'test', id: 'model' }, tokens: { input: 20, output: 0 } },
      actual: { model: { provider: 'test', id: 'model' }, tokens: { input: 17, output: 0 } },
      basis: {
        kind: 'estimated-baseline',
        method: 'markitdown-prompt-token-ratio-202609-v1',
      },
      dimensions: { tool: 'read' },
    }));
  });

  it('estimates UTF-8 bytes across mixed content blocks', () => {
    const report = vi.fn(async () => undefined);

    reportMarkitdownSavings(
      { report },
      { provider: 'test', id: 'model' },
      'read',
      [{ type: 'text', text: 'éééé' }, { type: 'image', data: 'ignored' }, { type: 'text', text: 'x' }],
    );

    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      baseline: { model: { provider: 'test', id: 'model' }, tokens: { input: 4, output: 0 } },
      actual: { model: { provider: 'test', id: 'model' }, tokens: { input: 3, output: 0 } },
    }));
  });

  it('ignores missing attribution data and keeps reporter failures fail-open', async () => {
    const report = vi.fn(async () => { throw new Error('unavailable'); });

    expect(() => reportMarkitdownSavings(
      { report },
      { provider: 'test', id: 'model' },
      'read_document',
      [{ type: 'text', text: 'converted' }],
    )).not.toThrow();
    reportMarkitdownSavings(undefined, { provider: 'test', id: 'model' }, 'read', [{ type: 'text', text: 'x' }]);
    reportMarkitdownSavings({ report }, undefined, 'read', [{ type: 'text', text: 'x' }]);
    reportMarkitdownSavings({ report }, { provider: 'test', id: 'model' }, 'read', []);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(report).toHaveBeenCalledOnce();
  });

  it('keeps synchronous reporter failures fail-open', () => {
    const report = vi.fn(() => { throw new Error('unavailable'); });

    expect(() => reportMarkitdownSavings(
      { report },
      { provider: 'test', id: 'model' },
      'read',
      [{ type: 'text', text: 'converted' }],
    )).not.toThrow();
    expect(report).toHaveBeenCalledOnce();
  });
});
