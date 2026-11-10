import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-felan-api package boundary', () => {
  it('publishes a portable package with a compatible Agent Core peer', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const notice = await readFile(join(packageRoot, 'NOTICE'), 'utf8');
    expect(manifest).toMatchObject({
      name: '@felan-ai/ext-felan-api',
      license: 'MIT',
      exports: { '.': { import: './dist/extension.js', types: './dist/extension.d.ts' }, './extension': { import: './dist/extension.js' }, './service': { import: './dist/service.js' } },
      dependencies: { typebox: '1.1.38' },
      peerDependencies: { '@felan-ai/agent-core': '^0.15.0' },
      devDependencies: { '@felan-ai/agent-core': 'workspace:*' },
      publishConfig: { access: 'public', provenance: true },
    });
    expect(notice).toContain('TypeBox 1.1.38');
  });
});
