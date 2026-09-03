import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-session-title package boundary', () => {
  it('publishes a compatible public package', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({
      name: '@felan-ai/ext-session-title',
      version: '0.1.0',
      license: 'MIT',
      peerDependencies: { '@felan-ai/agent-core': '^0.5.7' },
      devDependencies: { '@felan-ai/agent-core': 'workspace:*' },
      publishConfig: { access: 'public', provenance: true },
      exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
    });
    expect(await readFile(join(packageRoot, 'LICENSE'), 'utf8')).toContain('MIT License');
    expect(await readFile(join(packageRoot, 'NOTICE'), 'utf8')).toContain('original Felan code');
  });

  it('does not import application, filesystem, or network dependencies', async () => {
    const source = await readFile(join(packageRoot, 'src', 'index.ts'), 'utf8');
    expect(source).not.toMatch(/node:|supabase|daytona|fetch\(|process\.|@earendil-works/u);
  });

  it('exposes skip reporting for host diagnostics', async () => {
    const contracts = await readFile(join(packageRoot, 'src', 'contracts.ts'), 'utf8');
    expect(contracts).toContain('SessionTitleSkip');
    expect(contracts).toContain('reportSkip');
  });
});
