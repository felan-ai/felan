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
    peerDependencies: { '@felan-ai/agent-core': '^0.14.0' },
  });
});

it('keeps service contracts and root composition free of host I/O and presentation construction', async () => {
  const source = (await Promise.all(['extension.ts', 'runtime.ts'].map(file => readFile(new URL(`../../../../packages/ext-powerline/src/${file}`, import.meta.url), 'utf8')))).join('\n');
  expect(source).not.toMatch(/node:|process\.|fetch\(|setFooter\(|new PowerlineFooter/u);
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

it('keeps the transitive package-local root graph free of TUI modules', async () => {
  const pending = ['extension.ts'];
  const seen = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    expect(file).not.toMatch(/^(?:tui|footer|footer-renderer|projected-footer|colors)\.ts$/u);
    const source = await readFile(new URL(`../../../../packages/ext-powerline/src/${file}`, import.meta.url), 'utf8');
    expect(source).not.toContain('@earendil-works/pi-tui');
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\()\s*['"]([^'"]+)['"]/gu)) {
      const specifier = match[1]!;
      if (specifier.startsWith('./')) pending.push(specifier.slice(2).replace(/\.js$/u, '.ts'));
    }
  }
  expect(seen.has('runtime.ts')).toBe(true);
  expect(seen.has('service.ts')).toBe(false);
  expect(seen.has('core-services.ts')).toBe(true);
});
