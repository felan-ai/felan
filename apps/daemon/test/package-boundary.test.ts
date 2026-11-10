import { readFile, readdir } from 'node:fs/promises';
import { expect, it } from 'vitest';

const rules = [
  {
    paths: ['src/'],
    forbidden: [
      /(?:from\s*|import\s*\()\s*['"][^'"]*(?:felan\/src|@felan-ai\/felan|@napi-rs\/keyring)/u,
      /(?:from\s*|import\s*\()\s*['"]@felan-ai\/ext-/u,
      /piExtensions|llamaCpp|felanClassifier|builtinExtensions/u,
    ],
    reason: 'The daemon owns canonical lifetime, not local client providers or extensions',
  },
  {
    paths: ['src/daemon/extension-ui.ts'],
    forbidden: [/from\s+['"][^'"]*(?:pi-tui|\/felan|InteractiveMode)/u],
    reason: 'Daemon UI serializes portable data without constructing client renderers',
  },
];

it('enforces daemon ownership boundaries', async () => {
  const sources = new Map<string, string>();
  for (const rule of rules) for (const path of rule.paths) {
    const files = path.endsWith('/') ? (await readdir(new URL(`../${path}`, import.meta.url), { recursive: true }))
      .filter(file => file.endsWith('.ts')).map(file => `${path}${file}`) : [path];
    expect(files.length, rule.reason).toBeGreaterThan(0);
    for (const file of files) {
      if (!sources.has(file)) sources.set(file, await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
      for (const forbidden of rule.forbidden) expect(sources.get(file), `${rule.reason}: ${file}`).not.toMatch(forbidden);
    }
  }
});

it('publishes client, provider and lightweight host boundaries instead of implementation subpaths', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  expect(Object.keys(manifest.exports).sort()).toEqual([
    '.', './client', './daemon-bootstrap', './host-config', './host-token', './provider', './session-runtime', './version',
  ]);
  for (const dependencies of [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies]) {
    expect(dependencies ?? {}).not.toHaveProperty('@felan-ai/felan');
  }
  expect(manifest.dependencies).not.toHaveProperty('@napi-rs/keyring');
});
