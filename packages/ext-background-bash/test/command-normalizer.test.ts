import { describe, expect, it } from 'vitest';
import { normalizeBackgroundCommand } from '../src/command-normalizer.js';

describe('normalizeBackgroundCommand', () => {
  it('removes the RTK wrapper while preserving leading environment assignments', () => {
    expect(normalizeBackgroundCommand(
      'export RTK_DB_PATH="/tmp/rtk db"; CI=1 rtk pnpm test',
    )).toEqual({
      command: 'CI=1 pnpm test',
      originalCommand: 'export RTK_DB_PATH="/tmp/rtk db"; CI=1 rtk pnpm test',
      rtkRewriteRemoved: true,
    });
  });

  it('leaves unrelated commands unchanged', () => {
    expect(normalizeBackgroundCommand('pnpm dev')).toEqual({
      command: 'pnpm dev',
      rtkRewriteRemoved: false,
    });
  });
});
