import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

const extensions = ['ask-user', 'background-bash', 'codebase-memory', 'codex', 'context-view', 'fusion', 'powerline', 'prewalk', 'prompt-history', 'tasks'];

it('publishes extensions without terminal entrypoints or renderer dependencies', async () => {
  for (const name of extensions) {
    const manifest = JSON.parse(await readFile(new URL(`../../../../packages/ext-${name}/package.json`, import.meta.url), 'utf8'));
    expect(manifest.exports, name).not.toHaveProperty('./tui');
    if (name !== 'prompt-history') expect(manifest.dependencies, name).not.toHaveProperty('@earendil-works/pi-tui');
  }
});
