import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-tasks package boundary', () => {
  it('has public package metadata and source attribution', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const license = await readFile(join(packageRoot, 'LICENSE'), 'utf8');
    const notice = await readFile(join(packageRoot, 'NOTICE'), 'utf8');

    expect(manifest).toMatchObject({
      name: '@felan-ai/ext-tasks',
      license: 'MIT',
      repository: {
        type: 'git',
        url: 'git+https://github.com/felan-ai/felan.git',
        directory: 'packages/ext-tasks',
      },
      publishConfig: { access: 'public', provenance: true },
      exports: { '.': { import: './dist/extension.js', types: './dist/extension.d.ts' } },
    });
    expect(manifest.exports).not.toHaveProperty('./tui');
    expect(manifest.exports).not.toHaveProperty('./service');
    expect(license).toContain('MIT License');
    expect(notice).toContain('9571293d422db11de893fa80ed0fc3e39945c657');
    expect(notice).toContain('No source code was copied');
    expect(notice).toContain('TypeBox 1.1.38');
  });
});
