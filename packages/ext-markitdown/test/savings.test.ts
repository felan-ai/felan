import { describe, expect, it, vi } from 'vitest';
import { reportMarkitdownSavings } from '../src/savings.js';

describe('MarkItDown savings', () => {
  it('requires attribution and visible text, and keeps reporter failures fail-open', () => {
    for (const fail of [
      () => Promise.reject(new Error('unavailable')),
      () => { throw new Error('unavailable'); },
    ]) {
      const report = vi.fn(fail);
      const model = { provider: 'test', id: 'model' };
      reportMarkitdownSavings(undefined, model, 'read', [{ type: 'text', text: 'converted' }]);
      reportMarkitdownSavings({ report }, undefined, 'read', [{ type: 'text', text: 'converted' }]);
      reportMarkitdownSavings({ report }, model, 'read', [{ type: 'image', data: 'ignored' }]);
      expect(report).not.toHaveBeenCalled();
      expect(() => reportMarkitdownSavings({ report }, model, 'read', [{ type: 'text', text: 'converted' }])).not.toThrow();
      expect(report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        category: 'output-optimization', operation: 'document-read',
        baseline: expect.objectContaining({ model }), actual: expect.objectContaining({ model }),
        basis: expect.objectContaining({ kind: 'estimated-baseline' }), dimensions: { tool: 'read' },
      }));
    }
  });
});
