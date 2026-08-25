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
      version: '0.2.0',
      license: 'MIT',
      exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
      dependencies: { typebox: '1.1.38' },
      peerDependencies: { '@felan-ai/agent-core': '^0.5.0' },
      devDependencies: { '@felan-ai/agent-core': 'workspace:*' },
      publishConfig: { access: 'public', provenance: true },
    });
    expect(notice).toContain('TypeBox 1.1.38');
  });

  it('does not depend on cloud-only modules or expose the credential in source', async () => {
    const source = await readFile(join(packageRoot, 'src', 'index.ts'), 'utf8');
    expect(source).not.toContain('@felan-cloud');
    expect(source).not.toContain('TEAM_API_KEY');
    expect(source).not.toContain('secret-key');
  });
});
