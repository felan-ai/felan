import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { getExtensionConfigDefinition } from '@felan-ai/agent-core';
import * as root from '../../../../packages/ext-codex/src/index.js';
import * as runtime from '../../../../packages/ext-codex/src/runtime.js';
import * as tui from '../../src/tui/renderers/codex.js';

it('publishes portable entries without client code with the declared peer and source attribution', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../../../packages/ext-codex/package.json', import.meta.url), 'utf8'));
  expect(manifest).toMatchObject({
    name: '@felan-ai/ext-codex',
    peerDependencies: { '@felan-ai/agent-core': '^0.13.0' },
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './runtime': { types: './dist/runtime.d.ts', import: './dist/runtime.js' },

    },
  });
  const notice = await readFile(new URL('../../../../packages/ext-codex/NOTICE', import.meta.url), 'utf8');
  for (const source of ['@howaboua/pi-codex-conversion 3.0.8', '62d1501ac0c6acb39c4b4d225a9e9056a7ba3b91',
    'b4b99630cda3c066749af0fb3ac9b8184b2a4c7d', 'f16fee563f71849cc2b9a94be2b6f70e12fca804', '61b493cf76cdd8e4789dd08d3a0ecee6c1c7c6eb']) {
    expect(notice).toContain(source);
  }
});

it('keeps root and runtime exports identical without losing configuration or execution contributions', () => {
  expect(Object.keys(root).sort()).toEqual(Object.keys(runtime).sort());
  expect(root.default).toBe(runtime.default);
  expect(root.createCodexTools).toBe(runtime.createCodexExecutionTools);
  expect(root.createCodexExtension).toBe(runtime.createCodexExtension);
  expect(tui).not.toHaveProperty('createCodexTools');
  expect(tui).not.toHaveProperty('default');
  for (const extension of [root.default, runtime.default, root.createCodexExtension()]) {
    expect(getExtensionConfigDefinition(extension)).toEqual(root.CODEX_CONFIG);
    expect(extension.execution).toEqual(expect.any(Function));
  }
});
