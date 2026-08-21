import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-output-style package boundary', () => {
  it('has public package metadata and original-code attribution', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const license = await readFile(join(packageRoot, 'LICENSE'), 'utf8');
    const notice = await readFile(join(packageRoot, 'NOTICE'), 'utf8');

    expect(manifest).toMatchObject({
      name: '@felan-ai/ext-output-style',
      version: '0.1.0',
      license: 'MIT',
      repository: {
        type: 'git',
        url: 'git+https://github.com/felan-ai/felan.git',
        directory: 'packages/ext-output-style',
      },
      publishConfig: { access: 'public', provenance: true },
      exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
      peerDependencies: { '@felan-ai/agent-core': '^0.4.0' },
    });
    expect(license).toContain('MIT License');
    expect(notice).toContain('original Felan code');
    expect(notice).toContain('no third-party runtime dependencies');
  });

  it('does not load prompts, files, or host-specific dependencies', async () => {
    const source = await readFile(join(packageRoot, 'src', 'index.ts'), 'utf8');

    expect(source).not.toMatch(/node:|@felan-cloud|@earendil-works/u);
    expect(source).not.toMatch(/readFile|fetch\(|process\./u);
  });
});
