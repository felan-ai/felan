import { expect, it } from 'vitest';
import { compactionPresentation, parseCompactionPresentation } from '../src/presentation.js';

it('projects only bounded display metadata from authoritative compaction entries', () => {
  expect(compactionPresentation({ tokensBefore: 1200, fromHook: true, details: {
    namespace: 'felan.session-compaction', schemaVersion: 1, method: 'classifier', privateTrace: 'not transmitted',
  } })).toEqual({ tokensBefore: 1200, method: 'Classifier' });
  expect(compactionPresentation({ tokensBefore: 10 })).toEqual({ tokensBefore: 10, method: 'Native' });
  expect(compactionPresentation({ tokensBefore: 10, fromHook: true, details: { method: 'other' } })).toEqual({ tokensBefore: 10 });
  for (const value of [{ tokensBefore: Infinity }, { tokensBefore: -1 }, { tokensBefore: 1, method: 'invented' }, { tokensBefore: 1, summary: 'unexpected' }]) {
    expect(() => parseCompactionPresentation(value)).toThrow();
  }
});
