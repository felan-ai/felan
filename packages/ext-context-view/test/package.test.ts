import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-context-view package boundary', () => {
  it('publishes public metadata and source attribution', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const notice = await readFile(join(packageRoot, 'NOTICE'), 'utf8');
    expect(manifest).toMatchObject({
      name: '@felan-ai/ext-context-view',
      version: '0.1.3',
      type: 'module',
      license: 'MIT',
      engines: { node: '>=22.19.0' },
      dependencies: { '@earendil-works/pi-tui': '0.85.0' },
      peerDependencies: { '@felan-ai/agent-core': '^0.5.5' },
      devDependencies: { '@felan-ai/agent-core': 'workspace:*' },
      publishConfig: { access: 'public', provenance: true },
      exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
    });
    expect(notice).toContain('packages/pi-context');
    expect(notice).toContain('7e72e509fe45a5a87c4c2e176cb711de994a8c1d');
    expect(notice).toContain('Pi-TUI 0.85.0');
  });

  it('keeps the feature free of direct host I/O and Pi package coupling', async () => {
    const sources = await sourceFiles(join(packageRoot, 'src'));
    const content = (await Promise.all(sources.map((path) => readFile(path, 'utf8')))).join('\n');
    expect(content).not.toMatch(/node:(?:child_process|fs|net|http)/u);
    expect(content).not.toContain('@earendil-works/pi-coding-agent');
    expect(content).toContain('@felan-ai/agent-core');
  });
});

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  }));
  return nested.flat().filter((path) => path.endsWith('.ts'));
}
