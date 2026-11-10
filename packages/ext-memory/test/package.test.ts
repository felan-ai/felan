import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOST_WORKERS_SERVICE, RUNTIME_LIFETIME_SERVICE, MODELS_SERVICE, SESSIONS_SERVICE } from '@felan-ai/agent-core';
import extension from '../src/extension.js';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-memory package boundary', () => {
  it('publishes a compatible portable package', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({
      name: '@felan-ai/ext-memory',
      license: 'MIT',
      peerDependencies: { '@felan-ai/agent-core': 'catalog:agent-core' },
      devDependencies: { '@felan-ai/agent-core': 'workspace:*' },
      publishConfig: { access: 'public', provenance: true },
      exports: {
        '.': { import: './dist/extension.js', types: './dist/extension.d.ts' },
      },
    });
    expect(manifest.exports['./service']).toBeUndefined();
  });

  it('declares core model and session services', () => {
    expect(extension.serviceRequirements).toEqual({ required: [MODELS_SERVICE, SESSIONS_SERVICE], optional: [HOST_WORKERS_SERVICE, RUNTIME_LIFETIME_SERVICE] });
  });
});
