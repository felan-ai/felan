import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const extensions = ['ask-user', 'background-bash', 'codebase-memory', 'codex', 'context-view', 'fusion', 'powerline', 'prewalk', 'prompt-history', 'tasks'];

async function sources(directory: URL): Promise<URL[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.filter(entry => entry.name !== '__tests__').map(async entry => {
    const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    return entry.isDirectory() ? sources(path) : entry.name.endsWith('.ts') ? [path] : [];
  }))).flat();
}

describe('extension/client rendering boundary', () => {
  it.each(extensions)('keeps %s free of terminal entrypoints and rendering imports', async name => {
    const root = new URL(`../../../../packages/ext-${name}/`, import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
    expect(manifest.exports).not.toHaveProperty('./tui');
    if (name !== 'prompt-history') expect(manifest.dependencies).not.toHaveProperty('@earendil-works/pi-tui');
    for (const path of await sources(new URL('src/', root))) {
      const source = await readFile(path, 'utf8');
      expect(source, path.pathname).not.toMatch(/\b(?:renderCall|renderResult|renderCalls|toolPresentation|registerMessageRenderer)\b/u);
      const imports = [...source.matchAll(/from\s*['"](@earendil-works\/pi-tui[^'"]*)['"]/gu)].map(match => match[1]);
      expect(imports, path.pathname).toEqual(name === 'prompt-history' && path.pathname.endsWith('/history.ts')
        ? ['@earendil-works/pi-tui'] : []);
    }
  });
});
