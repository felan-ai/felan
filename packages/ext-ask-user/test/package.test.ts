import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-ask-user package boundary', () => {
  it('publishes the portable root and explicit TUI adapter with pinned metadata', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({
      name: '@felan-ai/ext-ask-user',
      version: '0.2.0',
      type: 'module',
      license: 'MIT',
      engines: { node: '>=22.19.0' },
      dependencies: {
        '@earendil-works/pi-tui': '0.84.2',
        typebox: '1.1.38',
      },
      peerDependencies: { '@felan-ai/agent-core': '^0.5.0' },
      devDependencies: { '@felan-ai/agent-core': 'workspace:*' },
      publishConfig: { access: 'public', provenance: true },
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.js' },
        './tui': { types: './dist/tui.d.ts', import: './dist/tui.js' },
      },
    });
  });

  it('preserves license and source attribution', async () => {
    const license = await readFile(join(packageRoot, 'LICENSE'), 'utf8');
    const notice = await readFile(join(packageRoot, 'NOTICE'), 'utf8');
    expect(license).toContain('Copyright (c) 2026 Enzo Lucchesi');
    expect(notice).toContain('https://github.com/mslavov/pi-extensions');
    expect(notice).toContain('https://github.com/edlsh/pi-ask-user');
    expect(notice).toContain('7e72e509fe45a5a87c4c2e176cb711de994a8c1d');
    expect(notice).toContain('pi-ask-user 0.14.0');
    expect(notice).toContain('2de7e145227f7a527e995e323a50e7ee9bf88b0e');
    expect(notice).toContain('Pi-TUI 0.84.2');
    expect(notice).toContain('TypeBox 1.1.38');
  });

  it('keeps TUI and global bridge code out of the root module', async () => {
    const root = await readFile(join(packageRoot, 'src/index.ts'), 'utf8');
    const sources = (await readdir(join(packageRoot, 'src'))).filter((file) => file.endsWith('.ts'));
    const allSource = (await Promise.all(sources.map((file) => readFile(join(packageRoot, 'src', file), 'utf8')))).join('\n');
    expect(root).not.toContain('@earendil-works/pi-tui');
    expect(root).not.toContain('./tui.js');
    expect(allSource).not.toContain('Symbol.for');
    expect(allSource).not.toContain('pi-ask-user:external-bridge');
  });
});
