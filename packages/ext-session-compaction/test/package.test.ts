import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getExtensionConfigDefinition } from '@felan-ai/agent-core';
import sessionCompactionExtension, { SESSION_COMPACTION_CONFIG } from '../src/index.js';
import { createFallbackDiagnostic, fallbackDiagnosticBytes } from '../src/index.js';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-session-compaction package boundary', () => {
  it('publishes a compatible public package', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({
      name: '@felan-ai/ext-session-compaction',
      version: '0.1.2',
      license: 'MIT',
      peerDependencies: { '@felan-ai/agent-core': '^0.6.1' },
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

  it('declares inherit as the default summary model policy', () => {
    expect(getExtensionConfigDefinition(sessionCompactionExtension)).toBe(SESSION_COMPACTION_CONFIG);
    expect(SESSION_COMPACTION_CONFIG.fields.model).toMatchObject({
      default: 'inherit',
      values: ['inherit', 'xhigh', 'high', 'medium', 'low'],
    });
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
  });
});
