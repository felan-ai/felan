import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-browser package boundary', () => {
  it('has public package metadata and reviewed upstream attribution', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const license = await readFile(join(packageRoot, 'LICENSE'), 'utf8');
    const notice = await readFile(join(packageRoot, 'NOTICE'), 'utf8');

    expect(manifest).toMatchObject({
      name: '@felan-ai/ext-browser',
      license: 'MIT',
      repository: {
        type: 'git',
        url: 'git+https://github.com/felan-ai/felan.git',
        directory: 'packages/ext-browser',
      },
      publishConfig: { access: 'public', provenance: true },
      exports: {
        '.': { import: './dist/extension.js', types: './dist/extension.d.ts' },
        './service': { import: './dist/service.js', types: './dist/service.d.ts' },
      },
    });
    expect(license).toContain('MIT License');
    expect(notice).toContain('agent-browser 0.37.1');
    expect(notice).toContain('TypeBox 1.1.38');
  });
});
