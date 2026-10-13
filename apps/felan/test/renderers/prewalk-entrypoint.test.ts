import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getExtensionConfigDefinition } from '@felan-ai/agent-core';
import { describe, expect, it } from 'vitest';
import { createPrewalkExtension } from '../../../../packages/ext-prewalk/src/index.js';

function localModules(entry: string): Map<string, string> {
  const modules = new Map<string, string>();
  const visit = (path: string) => {
    if (modules.has(path)) return;
    const source = readFileSync(path, 'utf8'); modules.set(path, source);
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
      visit(resolve(dirname(path), match[1]!.replace(/\.js$/, '.ts')));
    }
  };
  visit(entry); return modules;
}

describe('Prewalk entrypoint boundary', () => {
  it('keeps the execution entrypoint independent from its terminal renderer', () => {
    const modules = localModules(fileURLToPath(new URL('../../../../packages/ext-prewalk/src/index.ts', import.meta.url)));
    expect([...modules.keys()].some(path => path.endsWith('/plan-review.ts'))).toBe(false);
    for (const source of modules.values()) expect(source).not.toMatch(/from\s*['"]@earendil-works\/pi-tui['"]/);
  });

  it('keeps the client renderer independent from the state machine and its execution entrypoint', () => {
    const modules = localModules(fileURLToPath(new URL('../../src/tui/renderers/prewalk/plan-review.ts', import.meta.url)));
    expect([...modules.keys()].some(path => /\/(?:index|state|classification)\.ts$/.test(path))).toBe(false);
  });

  it('associates configuration with each host-bound factory result', () => {
    expect(getExtensionConfigDefinition(createPrewalkExtension({ review: async () => undefined }))?.id).toBe('prewalk');
  });
});
