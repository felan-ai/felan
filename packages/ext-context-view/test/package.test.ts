import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-context-view package boundary', () => {
  it('publishes public metadata and source attribution', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const notice = await readFile(join(packageRoot, 'NOTICE'), 'utf8');
    expect(manifest).toMatchObject({
      name: '@felan-ai/ext-context-view',
      type: 'module',
      license: 'MIT',
      engines: { node: '>=22.19.0' },
      dependencies: {},
      peerDependencies: { '@felan-ai/agent-core': '^0.15.0' },
      devDependencies: { '@felan-ai/agent-core': 'workspace:*' },
      publishConfig: { access: 'public', provenance: true },
      exports: {
        '.': { import: './dist/extension.js', types: './dist/extension.d.ts' },
      },
    });
    expect(notice).toContain('packages/pi-context');
    expect(notice).toContain('7e72e509fe45a5a87c4c2e176cb711de994a8c1d');
    expect(notice).toContain('Pi-TUI');
  });
});
