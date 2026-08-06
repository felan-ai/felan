import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-tasks package boundary', () => {
  it('has public package metadata and source attribution', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const license = await readFile(join(packageRoot, 'LICENSE'), 'utf8');
    const notice = await readFile(join(packageRoot, 'NOTICE'), 'utf8');

    expect(manifest).toMatchObject({
      name: '@felan-ai/ext-tasks',
      license: 'MIT',
      repository: {
        type: 'git',
        url: 'git+https://github.com/felan-ai/felan.git',
        directory: 'packages/ext-tasks',
      },
      publishConfig: { access: 'public', provenance: true },
      exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
    });
    expect(license).toContain('MIT License');
    expect(notice).toContain('9571293d422db11de893fa80ed0fc3e39945c657');
    expect(notice).toContain('No source code was copied');
    expect(notice).toContain('TypeBox 1.1.38');
  });

  it('routes persistence through AgentRuntime without cloud or subagent coupling', async () => {
    const sources = await sourceFiles(join(packageRoot, 'src'));
    const content = (await Promise.all(sources.map((path) => readFile(path, 'utf8')))).join('\n');

    expect(content).not.toMatch(/node:(?:child_process|fs)/u);
    expect(content).not.toMatch(/@felan-cloud|felan-platform|daytona-sdk/u);
    expect(content).not.toContain('@felan-ai/ext-subagents');
    expect(content).toContain("storage('session')");
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
