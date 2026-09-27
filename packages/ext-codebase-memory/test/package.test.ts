import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as packageEntry from '../src/index.js';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-codebase-memory package boundary', () => {
  it('publishes the intended package and preserves both upstream attributions', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const notice = await readFile(join(packageRoot, 'NOTICE'), 'utf8');
    expect(manifest).toMatchObject({
      name: '@felan-ai/ext-codebase-memory',
      peerDependencies: { '@felan-ai/agent-core': 'catalog:agent-core' },
      publishConfig: { access: 'public', provenance: true },
    });
    expect(notice).toContain('pi-cbm 1.2.1');
    expect(notice).toContain('921a749d5cea74bda8f647542627ef9518fec272');
    expect(notice).toContain('codebase-memory-mcp 0.11.0');
    expect(notice).toContain('8972ea69c6ad94b1ef1d4ffbf0a92d78d2db1798');
  });

  it('routes production I/O through AgentRuntime and explicitly covers both grep command tools', async () => {
    const sources = await sourceFiles(join(packageRoot, 'src'));
    const content = (await Promise.all(sources.map((path) => readFile(path, 'utf8')))).join('\n');
    expect(content).not.toMatch(/node:child_process|\bspawn\s*\(/u);
    expect(content).not.toMatch(/process\.env|node:os|\btmpdir\s*\(/u);
    expect(content).toContain("'bash'");
    expect(content).toContain("'exec_command'");
    expect(content).toContain("runtime.storage('agent')");
  });

  it('keeps clients and services internal and prevents installer configuration writes', async () => {
    expect(packageEntry).not.toHaveProperty('CbmClient');
    expect(packageEntry).not.toHaveProperty('ProjectService');
    expect(packageEntry).not.toHaveProperty('SymbolService');

    const installer = await readFile(join(packageRoot, 'src', 'installer.ts'), 'utf8');
    expect(installer).toContain('--skip-config');
    expect(installer).toContain('8972ea69c6ad94b1ef1d4ffbf0a92d78d2db1798');
    expect(installer).toContain('13049c7cc51bc508d68b8ecb8a9fd9574ecb7c6f2c9dd5a19bf7d4c187321145');
    expect(installer).toContain('HOME: installerHome');
    expect(installer).toContain('CBM_CACHE_DIR:');
    expect(installer).not.toMatch(/settings\.json|mcp\.json|AGENTS\.md/u);
  });
});

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  }))).flat().filter((path) => path.endsWith('.ts'));
}
