import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-rtk-optimizer package boundary', () => {
  it('has public package metadata and exact upstream attribution', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const notice = await readFile(join(packageRoot, 'NOTICE'), 'utf8');

    expect(manifest).toMatchObject({
      name: '@felan-ai/ext-rtk-optimizer',
      version: '0.1.0',
      license: 'MIT',
      repository: {
        type: 'git',
        url: 'git+https://github.com/felan-ai/felan.git',
        directory: 'packages/ext-rtk-optimizer',
      },
      peerDependencies: { '@felan-ai/agent-core': '^0.4.3' },
      publishConfig: { access: 'public', provenance: true },
      exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
    });
    expect(notice).toContain('pi-rtk-optimizer 0.9.0');
    expect(notice).toContain('d155d253cb2f1358e34e717d47a82ebccb08cb8e');
  });

  it('routes I/O through AgentRuntime and contains explicit Codex support', async () => {
    const sources = await sourceFiles(join(packageRoot, 'src'));
    const content = (await Promise.all(sources.map((path) => readFile(path, 'utf8')))).join('\n');

    expect(content).not.toMatch(/node:(?:child_process|fs)/u);
    expect(content).not.toContain('@earendil-works/pi-coding-agent');
    expect(content).toContain("'exec_command'");
    expect(content).toContain("'write_stdin'");
    expect(content).toContain('record.cmd = command');
    expect(content).toContain('CODEX_OUTPUT_MARKER');
  });
});

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : [path];
    }),
  );
  return nested.flat().filter((path) => path.endsWith('.ts'));
}
