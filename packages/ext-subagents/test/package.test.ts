import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-subagents package boundary', () => {
  it('has MIT, provenance, public export, and source attribution metadata', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const license = await readFile(join(packageRoot, 'LICENSE'), 'utf8');
    const notice = await readFile(join(packageRoot, 'NOTICE'), 'utf8');

    expect(manifest).toMatchObject({
      name: '@felan-ai/ext-subagents',
      license: 'MIT',
      repository: {
        type: 'git',
        url: 'git+https://github.com/felan-ai/felan.git',
        directory: 'packages/ext-subagents',
      },
      publishConfig: { access: 'public', provenance: true },
      exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
    });
    expect(license).toContain('MIT License');
    expect(notice).toContain('7e72e509fe45a5a87c4c2e176cb711de994a8c1d');
    expect(notice).toContain('No source code was copied');
  });

  it('contains no private cloud imports or terminal dependencies', async () => {
    const sources = (await readdir(join(packageRoot, 'src'))).filter((file) => file.endsWith('.ts'));
    const content = (await Promise.all(
      sources.map((file) => readFile(join(packageRoot, 'src', file), 'utf8')),
    )).join('\n');

    expect(content).not.toMatch(/felan-platform|supabase|daytona|pi-tui|InteractiveMode/);
  });
});
