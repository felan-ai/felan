import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-web-access package boundary', () => {
  it('publishes only the current pinned runtime dependencies', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const notice = await readFile(join(packageRoot, 'NOTICE'), 'utf8');

    expect(manifest).toMatchObject({
      name: '@felan-ai/ext-web-access',
      description: 'Secure bounded web search and content access for Felan',
      license: 'MIT',
      exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
      peerDependencies: { '@felan-ai/agent-core': 'catalog:agent-core' },
      devDependencies: { '@felan-ai/agent-core': 'workspace:*' },
      publishConfig: { access: 'public', provenance: true },
      scripts: {
        test: 'vitest run',
        'test:dist': 'pnpm run build && vitest run --config test/vitest.dist.config.ts',
      },
    });
    expect(manifest.dependencies).toEqual({
      '@mozilla/readability': '0.6.0',
      linkedom: '0.16.11',
      turndown: '7.2.0',
      typebox: '1.1.38',
      undici: '8.11.2',
    });
    expect(notice).toContain('pi-web-access 0.18.0');
    expect(notice).toContain('d2aab00dcf0547572276d9de4bc4a2a49d640e13');
    expect(notice).toContain('undici 8.11.2');
    expect(notice).not.toMatch(/promise\.try|unpdf|PDF\.js|pdfjs-dist/iu);
    expect(notice).not.toMatch(/pi-web-access 0\.23\.0/u);
  });
});
