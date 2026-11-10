import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-rtk-optimizer package boundary', () => {
  it('has public package metadata and exact upstream attribution', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const notice = await readFile(join(packageRoot, 'NOTICE'), 'utf8');

    expect(manifest).toMatchObject({
      name: '@felan-ai/ext-rtk-optimizer',
      license: 'MIT',
      repository: {
        type: 'git',
        url: 'git+https://github.com/felan-ai/felan.git',
        directory: 'packages/ext-rtk-optimizer',
      },
      peerDependencies: { '@felan-ai/agent-core': 'catalog:agent-core' },
      publishConfig: { access: 'public', provenance: true },
      exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
    });
    expect(notice).toContain('pi-rtk-optimizer 0.9.0');
    expect(await readFile(join(packageRoot, '../../pnpm-workspace.yaml'), 'utf8')).toContain("'@felan-ai/agent-core': ^0.15.0");
    expect(notice).toContain('d155d253cb2f1358e34e717d47a82ebccb08cb8e');
  });
});
