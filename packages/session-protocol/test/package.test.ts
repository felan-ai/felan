import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as protocol from '../src/index.js';

describe('public package boundary', () => {
  it('contains only browser-safe local and TypeBox imports', () => {
    const source = resolve(import.meta.dirname, '../src');
    for (const file of readdirSync(source).filter(name => name.endsWith('.ts'))) {
      const text = readFileSync(resolve(source, file), 'utf8');
      const imports = [...text.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)].map(match => match[2]!);
      expect(imports.every(name => name.startsWith('./') || name === 'typebox' || name === 'typebox/value'), file).toBe(true);
      expect(text, file).not.toMatch(/\bprocess\.(?:env|cwd|chdir|pid|platform|stdout|stdin|stderr)\b|\b(?:Buffer|require)\s*[.(]/);
    }
  });
  it('ships a single ESM export and one direct dependency at intended 0.1.0', () => {
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'));
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.type).toBe('module');
    expect(manifest.dependencies).toEqual({ typebox: '1.1.38' });
    expect(Object.keys(manifest.exports)).toEqual(['.']);
    expect(protocol).toHaveProperty('ClientEnvelopeSchema');
    expect(protocol).toHaveProperty('StoredEventRowSchema');
  });
});
