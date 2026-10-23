import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getExtensionConfigDefinition } from '@felan-ai/agent-core';
import sessionCompactionExtension, { DEFAULT_SESSION_COMPACTION_CONFIG, SESSION_COMPACTION_CONFIG } from '../src/index.js';
import { createFallbackDiagnostic, fallbackDiagnosticBytes, fallbackDiagnosticText } from '../src/index.js';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-session-compaction package boundary', () => {
  it('publishes a compatible public package', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({
      name: '@felan-ai/ext-session-compaction',
      license: 'MIT',
      peerDependencies: { '@felan-ai/agent-core': 'catalog:agent-core' },
      devDependencies: { '@felan-ai/agent-core': 'workspace:*' },
      publishConfig: { access: 'public', provenance: true },
      exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
    });
    expect(await readFile(join(packageRoot, 'LICENSE'), 'utf8')).toContain('MIT License');
    expect(await readFile(join(packageRoot, 'NOTICE'), 'utf8')).toContain('original Felan');
  });

  it('keeps the package host-neutral', async () => {
    const source = await readFile(join(packageRoot, 'src', 'index.ts'), 'utf8');
    expect(source).not.toMatch(/node:|supabase|daytona|fetch\(|process\.|@earendil-works/u);
  });

  it('declares verified summary with inherit as the default policy', () => {
    expect(getExtensionConfigDefinition(sessionCompactionExtension)).toBe(SESSION_COMPACTION_CONFIG);
    expect(SESSION_COMPACTION_CONFIG.fields.method).toMatchObject({
      default: 'summary',
      values: ['summary', 'classifier'],
    });
    expect(SESSION_COMPACTION_CONFIG.fields.model).toMatchObject({
      default: 'inherit',
      values: ['inherit', 'xhigh', 'high', 'medium', 'low'],
    });
  });

  it('enables idle expiry compaction by default', () => {
    expect(DEFAULT_SESSION_COMPACTION_CONFIG).toEqual({
      method: 'summary', model: 'inherit',
      compactBeforeCacheExpiry: true, minContextTokens: 200_000,
    });
    expect(SESSION_COMPACTION_CONFIG.fields.compactBeforeCacheExpiry).toMatchObject({
      type: 'boolean', default: true, label: 'Compact before cache expiry',
      description: 'When idle, compact shortly before a known prompt-cache lifetime expires',
    });
    expect(SESSION_COMPACTION_CONFIG.fields.minContextTokens).toMatchObject({
      type: 'number', default: 200_000, label: 'Expiry compaction minimum',
      description: 'Smallest context (tokens) worth compacting before cache expiry',
    });
  });

  it.each([NaN, Infinity, -Infinity, -1, 0.5, '200000', null, undefined])('rejects an invalid expiry minimum %j', (value) => {
    expect(SESSION_COMPACTION_CONFIG.fields.minContextTokens.validate?.(value)).toBeDefined();
  });

  it.each([0, 1, 200_000])('accepts expiry minimum %d', (value) => {
    expect(SESSION_COMPACTION_CONFIG.fields.minContextTokens.validate?.(value)).toBeUndefined();
  });

  it('bounds and redacts fallback diagnostics', () => {
    const diagnostic = createFallbackDiagnostic({
      reason: 'model-request-failed', sessionId: 'session-1', trigger: 'threshold', willRetry: false,
      requestedModel: 'low', errorMessage: 'Bearer secret https://example.test/?token=raw ' + 'x'.repeat(10_000),
    });
    expect(diagnostic.errorMessage).toContain('Bearer [redacted]');
    expect(diagnostic.errorMessage).toContain('token=[redacted]');
    expect(diagnostic.errorMessage).not.toContain('raw');
    expect(fallbackDiagnosticBytes(diagnostic)).toBeLessThan(3_000);
    expect(fallbackDiagnosticText(diagnostic)).toBe('Felan compaction failed; native compaction will take over.');
  });

  it('strips control and bidi characters before redacting bounded diagnostic fields', () => {
    const text = `api_key\u0000=secret-value Bearer\u0000 bearer-secret token\u202e=token-value ${'界'.repeat(2_000)}`;
    const diagnostic = createFallbackDiagnostic({
      reason: 'model-request-failed', sessionId: 'session-1', trigger: 'threshold', willRetry: false,
      requestedModel: 'low', errorMessage: new Error(text), detail: text,
    });

    for (const [value, maxBytes] of [[diagnostic.errorMessage, 1_024], [diagnostic.detail, 512]] as const) {
      expect(value).toContain('api_key=[redacted] Bearer [redacted] token=[redacted]');
      expect(value).not.toContain('secret-value');
      expect(value).not.toContain('bearer-secret');
      expect(value).not.toContain('token-value');
      expect(value).not.toContain('\u0000');
      expect(value).not.toContain('\u202e');
      expect(new TextEncoder().encode(value).byteLength).toBeLessThanOrEqual(maxBytes);
    }
    expect(fallbackDiagnosticBytes(diagnostic)).toBeLessThan(3_000);
  });
});
