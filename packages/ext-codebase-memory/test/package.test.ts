import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as packageEntry from '../src/index.js';
import * as runtimeEntry from '../src/runtime.js';

const packageRoot = resolve(import.meta.dirname, '..');

describe('@felan-ai/ext-codebase-memory package boundary', () => {
  it('publishes the intended package and preserves both upstream attributions', async () => {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const notice = await readFile(join(packageRoot, 'NOTICE'), 'utf8');
    expect(manifest).toMatchObject({
      name: '@felan-ai/ext-codebase-memory',
      peerDependencies: { '@felan-ai/agent-core': 'catalog:agent-core' },
      publishConfig: { access: 'public', provenance: true },
      exports: {
        '.': { types: './dist/index.d.ts', import: './dist/index.js' },
        './runtime': { types: './dist/runtime.d.ts', import: './dist/runtime.js' },

      },
    });
    expect(notice).toContain('pi-cbm 1.2.1');
    expect(await readFile(join(packageRoot, '../../pnpm-workspace.yaml'), 'utf8')).toContain("'@felan-ai/agent-core': ^0.15.0");
    expect(notice).toContain('921a749d5cea74bda8f647542627ef9518fec272');
    expect(notice).toContain('codebase-memory-mcp 0.11.0');
    expect(notice).toContain('8972ea69c6ad94b1ef1d4ffbf0a92d78d2db1798');
  });

  it('exposes the renderer-free runtime API directly from the public root', () => {
    expect(packageEntry.default).toBe(runtimeEntry.default);
    expect(packageEntry.createCodebaseMemoryExtension).toBe(runtimeEntry.createCodebaseMemoryExtension);
    expect(Object.keys(packageEntry).sort()).toEqual(Object.keys(runtimeEntry).sort());
  });

  it('keeps clients and services internal', async () => {
    expect(packageEntry).not.toHaveProperty('CbmClient');
    expect(packageEntry).not.toHaveProperty('ProjectService');
    expect(packageEntry).not.toHaveProperty('SymbolService');

  });
});
