import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
it('exports no custom view or extension-specific service contract', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  expect(manifest.exports).not.toHaveProperty('./view');
  expect(manifest.exports).not.toHaveProperty('./service');
});
