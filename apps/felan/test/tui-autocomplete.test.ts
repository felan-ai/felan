import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createCommandAutocomplete } from '../src/tui/commands.js';
import type { TuiSessionController } from '../src/tui/controller.js';

const directories: string[] = [];
const originalPath = process.env.PATH;
const originalLog = process.env.FD_LOG;
afterEach(async () => {
  process.env.PATH = originalPath;
  if (originalLog === undefined) delete process.env.FD_LOG; else process.env.FD_LOG = originalLog;
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

it('completes a file path on a later prompt line when Tab forces completion', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'tui-autocomplete-'));
  directories.push(cwd);
  await writeFile(join(cwd, 'example.ts'), 'export {};\n');
  const controller = { snapshot: { cwd, catalog: { commands: [] } } } as unknown as TuiSessionController;
  const provider = createCommandAutocomplete(controller);
  const lines = ['Review this file:', 'exa'];
  const suggestions = await provider.getSuggestions(lines, 1, 3, { signal: new AbortController().signal, force: true });

  expect(suggestions?.items).toContainEqual(expect.objectContaining({ value: 'example.ts' }));
  const item = suggestions!.items.find(item => item.value === 'example.ts')!;
  expect(provider.applyCompletion(lines, 1, 3, item, suggestions!.prefix)).toEqual({
    lines: ['Review this file:', 'example.ts'], cursorLine: 1, cursorCol: 10,
  });
});

it('preserves quoted paths containing spaces in a forced completion', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'tui-autocomplete-'));
  directories.push(cwd);
  await writeFile(join(cwd, 'example file.ts'), 'export {};\n');
  const provider = createCommandAutocomplete({ snapshot: { cwd, catalog: { commands: [] } } } as unknown as TuiSessionController);
  const suggestions = await provider.getSuggestions(['"exa'], 0, 4, { signal: new AbortController().signal, force: true });

  expect(suggestions?.items).toContainEqual(expect.objectContaining({ value: '"example file.ts"' }));
});

it('uses fd for fuzzy @ mentions and follows the current session cwd', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'tui-autocomplete-'));
  const nextCwd = await mkdtemp(join(tmpdir(), 'tui-autocomplete-'));
  const bin = await mkdtemp(join(tmpdir(), 'tui-autocomplete-bin-'));
  directories.push(cwd, nextCwd, bin);
  const log = join(bin, 'cwd');
  process.env.FD_LOG = log;
  await writeFile(join(bin, 'fd'), '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\nprintf "%s" "$2" > "$FD_LOG"\nprintf "example.ts\\n"\n');
  await chmod(join(bin, 'fd'), 0o755);
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
  const snapshot = { cwd, catalog: { commands: [] } };
  const controller = { get snapshot() { return snapshot; } } as unknown as TuiSessionController;
  const provider = createCommandAutocomplete(controller);
  const options = { signal: new AbortController().signal };

  expect((await provider.getSuggestions(['@exa'], 0, 4, options))?.items).toContainEqual(
    expect.objectContaining({ value: '@example.ts' }),
  );
  snapshot.cwd = nextCwd;
  await provider.getSuggestions(['@exa'], 0, 4, options);
  expect(await readFile(log, 'utf8')).toBe(nextCwd);
});

it('keeps slash command completion and rejects an aborted request', async () => {
  const controller = { snapshot: { cwd: tmpdir(), catalog: { commands: [{ name: 'review', description: 'Review changes' }] } } } as unknown as TuiSessionController;
  const provider = createCommandAutocomplete(controller);
  expect((await provider.getSuggestions(['/rev'], 0, 4, { signal: new AbortController().signal }))?.items)
    .toContainEqual(expect.objectContaining({ value: 'review', description: 'Review changes' }));
  const abort = new AbortController(); abort.abort();
  expect(await provider.getSuggestions(['/'], 0, 1, { signal: abort.signal })).toBeNull();
});
