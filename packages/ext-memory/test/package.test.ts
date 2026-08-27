import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-memory package boundary', () => {
  it('publishes a compatible portable package', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({
      name: '@felan-ai/ext-memory',
      version: '0.2.1',
      license: 'MIT',
      peerDependencies: { '@felan-ai/agent-core': '^0.5.0' },
      devDependencies: { '@felan-ai/agent-core': 'workspace:*' },
      publishConfig: { access: 'public', provenance: true },
      exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
    });
  });

  it('does not import application or cloud implementation details', async () => {
    const sources = (await readdir(join(packageRoot, 'src'))).filter((file) => file.endsWith('.ts'));
    const content = (await Promise.all(sources.map((file) => readFile(join(packageRoot, 'src', file), 'utf8')))).join('\n');
    expect(content).not.toMatch(/felan-platform|supabase|daytona|InteractiveMode|pi-tui/);
  });
});
