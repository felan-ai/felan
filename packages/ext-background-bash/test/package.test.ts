import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-background-bash package boundary', () => {
  it('has public package metadata and source attribution', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const notice = await readFile(join(packageRoot, 'NOTICE'), 'utf8');

    expect(manifest).toMatchObject({
      name: '@felan-ai/ext-background-bash',
      license: 'MIT',
      repository: {
        type: 'git',
        url: 'git+https://github.com/felan-ai/felan.git',
        directory: 'packages/ext-background-bash',
      },
      publishConfig: { access: 'public', provenance: true },
      exports: { '.': { import: './dist/extension.js', types: './dist/extension.d.ts' } },
      dependencies: { '@felan-ai/session-protocol': 'workspace:*' },
    });
    expect(manifest.exports['./service']).toBeUndefined();
    expect(notice).toContain('7e72e509fe45a5a87c4c2e176cb711de994a8c1d');
    expect(notice).toContain('TypeBox 1.1.38');
  });
});
