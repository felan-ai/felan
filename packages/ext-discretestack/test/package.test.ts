import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-discretestack package boundary', () => {
  it('publishes the extension and provider data without runtime dependencies', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({
      name: '@felan-ai/ext-discretestack',
      version: '0.1.0',
      type: 'module',
      license: 'MIT',
      repository: {
        type: 'git',
        url: 'git+https://github.com/felan-ai/felan.git',
        directory: 'packages/ext-discretestack',
      },
      peerDependencies: { '@felan-ai/agent-core': 'catalog:agent-core' },
      devDependencies: { '@felan-ai/agent-core': 'workspace:*' },
      publishConfig: { access: 'public', provenance: true },
    });
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.exports).toEqual({
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './provider': { types: './dist/provider.d.ts', import: './dist/provider.js' },
    });
    expect(await readFile(join(packageRoot, 'LICENSE'), 'utf8')).toContain('MIT License');
    const notice = await readFile(join(packageRoot, 'NOTICE'), 'utf8');
    expect(notice).toContain('original Felan code');
    expect(notice).toContain('no third-party runtime dependencies');
  });

  it('loads both built entrypoints and leaves provider data free of runtime imports', async () => {
    const extension = await import('@felan-ai/ext-discretestack');
    const provider = await import('@felan-ai/ext-discretestack/provider');
    expect(extension.default).toBeTypeOf('function');
    expect(extension.createDiscreteStackExtension).toBeTypeOf('function');
    expect(provider.DISCRETESTACK_PROVIDER_ID).toBe('discretestack');
    expect(provider.DISCRETESTACK_API_KEY_ENV).toBe('DISCRETESTACK_API_KEY');
    expect(provider.DISCRETESTACK_PROVIDER.apiKey).toBe('${DISCRETESTACK_API_KEY}');
    await access(join(packageRoot, 'dist', 'index.d.ts'));
    await access(join(packageRoot, 'dist', 'provider.d.ts'));

    const providerJs = await readFile(join(packageRoot, 'dist', 'provider.js'), 'utf8');
    expect(providerJs).not.toMatch(/\bimport(?!\s*\.)|\brequire\s*\(|\bfrom\s*['"]/u);
  });
});
