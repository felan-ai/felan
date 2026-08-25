import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-mcp package boundary', () => {
  it('publishes a host-injected portable package with pinned dependencies', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const managerSource = await readFile(join(packageRoot, 'src', 'manager.ts'), 'utf8');
    expect(manifest).toMatchObject({
      name: '@felan-ai/ext-mcp',
      version: '0.2.0',
      license: 'MIT',
      dependencies: {
        '@modelcontextprotocol/client': '2.0.0',
        typebox: '1.1.38',
      },
      peerDependencies: { '@felan-ai/agent-core': '^0.5.0' },
      devDependencies: { '@felan-ai/agent-core': 'workspace:*' },
    });
    expect(managerSource).toContain(`version: '${manifest.version}'`);
  });

  it('keeps local OAuth and ambient config behavior outside the portable source', async () => {
    const source = await readFile(join(packageRoot, 'src', 'index.ts'), 'utf8');
    const notice = await readFile(join(packageRoot, 'NOTICE'), 'utf8');
    expect(source).not.toContain('@napi-rs/keyring');
    expect(source).not.toContain("from 'open'");
    expect(source).not.toContain('.mcp.json');
    expect(notice).toContain('pi-mcp-adapter 2.21.0');
    expect(notice).toContain('eaf379782fddf836828811d1b71ad85d27bc70dd');
    expect(notice).toContain('pi-mcp-adapter 2.26.0');
    expect(notice).toContain('5ee81b47b571b3c4ac2e68a03812c64e3f95cb98');
    expect(notice).toContain('1bf36719cec478a163bb52e3390182963aab9f85');
  });
});
