import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as protocol from '../src/index.js';

describe('public package boundary', () => {
  it('ships a single ESM export and one direct dependency at intended 0.4.3', () => {
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'));
    expect(manifest.version).toBe('0.4.3');
    expect(manifest.type).toBe('module');
    expect(manifest.dependencies).toEqual({ typebox: '1.1.38' });
    expect(Object.keys(manifest.exports)).toEqual(['.']);
    expect(protocol).toHaveProperty('ClientEnvelopeSchema');
    expect(protocol).toHaveProperty('StoredEventRowSchema');
  });
});
