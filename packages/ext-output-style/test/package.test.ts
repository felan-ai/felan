import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-output-style package boundary', () => {
  it('has public package metadata and original-code attribution', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const license = await readFile(join(packageRoot, 'LICENSE'), 'utf8');
    const notice = await readFile(join(packageRoot, 'NOTICE'), 'utf8');

    expect(manifest).toMatchObject({
      name: '@felan-ai/ext-output-style',
      license: 'MIT',
      repository: {
        type: 'git',
        url: 'git+https://github.com/felan-ai/felan.git',
        directory: 'packages/ext-output-style',
      },
      publishConfig: { access: 'public', provenance: true },
      exports: { '.': { import: './dist/extension.js', types: './dist/extension.d.ts' }, './extension': { import: './dist/extension.js' } },
      peerDependencies: { '@felan-ai/agent-core': '^0.14.0' },
    });
    expect(license).toContain('MIT License');
    expect(notice).toContain('original Felan code');
    expect(notice).toContain('no third-party runtime dependencies');
    expect(notice).toContain('https://github.com/JuliusBrussee/caveman');
    expect(notice).toContain('Copyright (c) 2026 Julius Brussee');
    expect(license).toContain('Copyright (c) 2026 Julius Brussee');
  });

  it('loads configured files only through AgentRuntime', async () => {
    const files = await readdir(join(packageRoot, 'src'));
    const source = (await Promise.all(files.map(file => readFile(join(packageRoot, 'src', file), 'utf8')))).join('\n');
    expect(source).not.toMatch(/node:(?:fs|os|http|net)|@felan-cloud|@earendil-works/u);
    expect(source).not.toMatch(/fetch\(|process\./u);
    expect(source).toContain('runtime.readFile(resolvedPath)');
  });
});
