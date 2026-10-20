import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function modules(entry: string): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (path: string) => {
    if (found.has(path)) return;
    const source = readFileSync(path, 'utf8'); found.set(path, source);
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
      visit(resolve(dirname(path), match[1]!.replace(/\.js$/, '.ts')));
    }
  };
  visit(entry); return found;
}

describe('Fusion import boundaries', () => {
  it('does not load renderer modules from the execution entrypoint', () => {
    const graph = modules(fileURLToPath(new URL('../../../../packages/ext-fusion/src/index.ts', import.meta.url)));
    expect([...graph.keys()].some(path => /\/(tui|model-picker)\.ts$/.test(path))).toBe(false);
    for (const source of graph.values()) expect(source).not.toMatch(/from\s*['"]@earendil-works\/pi-tui['"]/);
  });

  it('does not load model execution or storage from the renderer', () => {
    const graph = modules(fileURLToPath(new URL('../../src/tui/renderers/fusion.ts', import.meta.url)));
    expect([...graph.keys()].some(path => /\/(index|models|orchestration|session-state)\.ts$/.test(path))).toBe(false);
    for (const source of graph.values()) expect(source).not.toMatch(/from\s*['"]node:(?:fs|child_process|net|https?)|streamSimple|readFile|writeFile/);
  });
});
