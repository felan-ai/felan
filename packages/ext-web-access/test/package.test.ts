import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-web-access package boundary', () => {
  it('has publish metadata, pinned dependencies, and upstream attribution', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const notice = await readFile(join(packageRoot, 'NOTICE'), 'utf8');
    expect(manifest).toMatchObject({
      name: '@felan-ai/ext-web-access',
      version: '0.1.1',
      license: 'MIT',
      exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
      peerDependencies: { '@felan-ai/agent-core': '^0.4.0' },
      devDependencies: { '@felan-ai/agent-core': 'workspace:*' },
      publishConfig: { access: 'public', provenance: true },
    });
    for (const version of Object.values(manifest.dependencies) as string[]) expect(version).not.toMatch(/^[~^*]/u);
    expect(notice).toContain('pi-web-access 0.18.0');
    expect(notice).toContain('d2aab00dcf0547572276d9de4bc4a2a49d640e13');
    expect(notice).toContain('undici 8.10.0');
    expect(notice).toContain('unpdf 1.6.2');
  });

  it('uses AgentRuntime for process and repository operations', async () => {
    const sourcePaths = await sourceFiles(join(packageRoot, 'src'));
    const sources = await Promise.all(sourcePaths.map(async (path) => ({ path, content: await readFile(path, 'utf8') })));
    expect(sources.map((source) => source.content).join('\n')).not.toMatch(/node:child_process/u);
    const directFsUsers = sources.filter((source) => /node:fs/u.test(source.content)).map((source) => source.path.replace(`${packageRoot}/`, ''));
    expect(directFsUsers).toEqual(['src/config.ts']);
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
