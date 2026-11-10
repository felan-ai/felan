import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-prompt-history package boundary', () => {
  it('publishes metadata and source attribution', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const notice = await readFile(join(packageRoot, 'NOTICE'), 'utf8');
    expect(manifest).toMatchObject({ name: '@felan-ai/ext-prompt-history', dependencies: { '@earendil-works/pi-tui': 'catalog:pi', '@felan-ai/session-protocol': 'workspace:*' }, peerDependencies: { '@felan-ai/agent-core': '^0.15.0' }, publishConfig: { access: 'public', provenance: true },
      exports: { '.': { import: './dist/extension.js', types: './dist/extension.d.ts' }, './extension': { import: './dist/extension.js' } } });
    expect(notice).toContain('packages/pi-prompt-history');
    expect(notice).toContain('7e72e509fe45a5a87c4c2e176cb711de994a8c1d');
  });
});
