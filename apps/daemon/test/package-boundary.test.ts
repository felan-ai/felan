import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('keeps local settings and credentials out of the daemon implementation', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  expect(manifest.dependencies).not.toHaveProperty('@napi-rs/keyring');
  expect(manifest.dependencies).not.toHaveProperty('@felan-ai/felan');
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  for (const file of await readdir(root, { recursive: true })) {
    if (!file.endsWith('.ts')) continue;
    const source = await readFile(`${root}/${file}`, 'utf8');
    expect(source, file).not.toMatch(/(?:from\s*|import\s*\()['"][^'"]*(?:felan\/src|@felan-ai\/felan|@napi-rs\/keyring)/u);
    expect(source, file).not.toMatch(/piExtensions|llamaCpp|felanClassifier|builtinExtensions/u);
  }
});

it('publishes client, provider and lightweight host boundaries instead of implementation subpaths', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  expect(Object.keys(manifest.exports).sort()).toEqual([
    '.', './client', './daemon-bootstrap', './host-config', './provider', './session-runtime', './version',
  ]);
});

it('keeps local provider tests outside the daemon suite', async () => {
  const root = fileURLToPath(new URL('./', import.meta.url));
  for (const file of await readdir(root, { recursive: true })) {
    if (!/\.(?:ts|mjs)$/u.test(file)) continue;
    const source = await readFile(`${root}/${file}`, 'utf8');
    expect(source, file).not.toMatch(/(?:from\s*|import\s*\(|new URL\s*\()['"][^'"]*felan\/(?:src\/providers|dist)/u);
  }
});
