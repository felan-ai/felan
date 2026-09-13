import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-run package boundary', () => {
  it('has public metadata and upstream attribution', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({
      name: '@felan-ai/ext-run',
      version: '0.1.0',
      license: 'MIT',
      dependencies: { '@earendil-works/pi-tui': '0.85.1', run: '2.1.4', typebox: '1.1.38' },
      peerDependencies: { '@felan-ai/agent-core': '^0.6.2' },
      exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
    });
    expect(await readFile(join(packageRoot, 'LICENSE'), 'utf8')).toContain('MIT License');
    expect(await readFile(join(packageRoot, 'NOTICE'), 'utf8')).toContain('Apache License 2.0');
  });

  it('contains no direct host access in the extension source', async () => {
    const files = await readdir(join(packageRoot, 'src'));
    const source = (await Promise.all(files.map((file) => readFile(join(packageRoot, 'src', file), 'utf8')))).join('\n');
    expect(source).not.toMatch(/node:(?:child_process|fs|net)/u);
    expect(source).not.toMatch(/\bprocess\s*\.\s*env/u);
    expect(source).toContain("from 'run'");
  });
});
