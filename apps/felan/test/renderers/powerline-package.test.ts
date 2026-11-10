import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import * as root from '../../../../packages/ext-powerline/src/extension.js';
import { createPowerlineRuntimeExtension } from '../../../../packages/ext-powerline/src/runtime.js';
import { renderFooterLine, renderStyledSegments } from '../../src/tui/renderers/powerline.js';

it('publishes generic-data root and runtime entries with a compatible Core peer', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../../../packages/ext-powerline/package.json', import.meta.url), 'utf8'));
  expect(manifest).toMatchObject({
    exports: { '.': { import: './dist/extension.js', types: './dist/extension.d.ts' },
      './extension': { import: './dist/extension.js' },
      './runtime': { import: './dist/runtime.js' } },
    peerDependencies: { '@felan-ai/agent-core': '^0.15.0' },
  });
});

it('exposes portable runtime APIs at the root and rendering only from the client', () => {
  expect(root.createPowerlineRuntimeExtension).toBe(createPowerlineRuntimeExtension);
  for (const name of ['createPowerlineExtension', 'PowerlineFooter', 'renderFooterLine', 'renderStyledSegments']) {
    expect(root).not.toHaveProperty(name);
  }
  for (const exported of [renderFooterLine, renderStyledSegments]) {
    expect(typeof exported).toBe('function');
  }
});
