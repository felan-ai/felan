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
      version: '0.1.7',
      peerDependencies: { '@felan-ai/agent-core': '^0.5.0' },
      publishConfig: { access: 'public', provenance: true },
    });
    expect(notice).toContain('pi-cbm 1.2.1');
    expect(notice).toContain('921a749d5cea74bda8f647542627ef9518fec272');
    expect(notice).toContain('codebase-memory-mcp 0.10.8');
    expect(notice).toContain('46ae198fc11cda80e817acbc5f5908d7c2de7032');
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
    expect(installer).toContain('46ae198fc11cda80e817acbc5f5908d7c2de7032');
    expect(installer).toContain('2fdd4d6563fc8e540bb32e233c5fdef22ecf05d7ebd5a80657cd4fec953b3475');
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
