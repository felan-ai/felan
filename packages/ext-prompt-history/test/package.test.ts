import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-prompt-history package boundary', () => {
  it('publishes metadata and source attribution', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const notice = await readFile(join(packageRoot, 'NOTICE'), 'utf8');
    expect(manifest).toMatchObject({ name: '@felan-ai/ext-prompt-history', version: '0.1.1', dependencies: { '@earendil-works/pi-tui': '0.84.4' }, peerDependencies: { '@felan-ai/agent-core': '^0.5.5' }, publishConfig: { access: 'public', provenance: true } });
    expect(notice).toContain('packages/pi-prompt-history');
    expect(notice).toContain('7e72e509fe45a5a87c4c2e176cb711de994a8c1d');
  });

  it('keeps direct host I/O and Pi coding-agent coupling out of package source', async () => {
    const sources = (await readdir(join(packageRoot, 'src'))).map((file) => join(packageRoot, 'src', file));
    const content = (await Promise.all(sources.map((path) => readFile(path, 'utf8')))).join('\n');
    expect(content).not.toMatch(/node:(?:fs|net|http)/u);
    expect(content).not.toContain('@earendil-works/pi-coding-agent');
  });
});
