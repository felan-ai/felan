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
      peerDependencies: { '@felan-ai/agent-core': '^0.14.0' },
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

  it('keeps root execution free of ambient credentials, hosts, or a legacy factory call', async () => {
    const source = await readFile(join(packageRoot, 'src', 'extension.ts'), 'utf8');
    expect(source).toContain('pi.services.get(FELAN_PLATFORM_SERVICE)');
    expect(source).not.toMatch(/process\.|createFelanApiExtension\(|https?:\/\//u);
  });
});
