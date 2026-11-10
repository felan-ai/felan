import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-mcp package boundary', () => {
  it('publishes a host-injected portable package with pinned dependencies', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({
      name: '@felan-ai/ext-mcp',
      license: 'MIT',
      dependencies: {
        '@modelcontextprotocol/client': '2.2.0',
        typebox: '1.1.38',
      },
      peerDependencies: { '@felan-ai/agent-core': 'catalog:agent-core' },
      devDependencies: { '@felan-ai/agent-core': 'workspace:*' },
      exports: {
        '.': { import: './dist/extension.js', types: './dist/extension.d.ts' },
        './service': { import: './dist/service.js', types: './dist/service.d.ts' },
      },
    });
  });

  it('preserves reviewed MCP source attribution', async () => {
    const notice = await readFile(join(packageRoot, 'NOTICE'), 'utf8');
    expect(notice).toContain('pi-mcp-adapter 2.21.0');
    expect(notice).toContain('eaf379782fddf836828811d1b71ad85d27bc70dd');
    expect(notice).toContain('pi-mcp-adapter 2.26.0');
    expect(notice).toContain('5ee81b47b571b3c4ac2e68a03812c64e3f95cb98');
    expect(notice).toContain('1bf36719cec478a163bb52e3390182963aab9f85');
  });
});
