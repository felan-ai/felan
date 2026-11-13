import childProcess from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createCommandAutocomplete } from '../src/tui/commands.js';
import type { TuiSessionController } from '../src/tui/controller.js';

const directories: string[] = [];
const originalPath = process.env.PATH;
const originalLog = process.env.FD_LOG;
afterEach(async () => {
  vi.restoreAllMocks(); syncBuiltinESMExports();
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

it.each(process.platform === 'win32' ? ['node'] : ['shell', 'node'])('uses fd for fuzzy @ mentions and follows the current session cwd with a %s fixture', async fixture => {
  const cwd = await mkdtemp(join(tmpdir(), 'tui-autocomplete-'));
  const nextCwd = await mkdtemp(join(tmpdir(), 'tui-autocomplete-'));
  const bin = await mkdtemp(join(tmpdir(), 'tui-autocomplete-bin-'));
  directories.push(cwd, nextCwd, bin);
  const log = join(bin, 'cwd');
  process.env.FD_LOG = log;
  if (fixture === 'shell') {
    await writeFile(join(bin, 'fd'), '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\nprintf "%s" "$2" > "$FD_LOG"\nprintf "example.ts\\n"\n');
    await chmod(join(bin, 'fd'), 0o755);
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ''}`;
  } else {
    const shim = join(bin, 'fd.cjs');
    await writeFile(shim, 'if (process.argv[2] === "--version") process.exit(0);\nrequire("node:fs").writeFileSync(process.env.FD_LOG, process.argv[3]);\nprocess.stdout.write("example.ts\\n");\n');
    const { spawn, spawnSync } = childProcess;
    vi.spyOn(childProcess, 'spawn').mockImplementation((command, args, options) => command === 'fd'
      ? spawn(process.execPath, [shim, ...args ?? []], options) : spawn(command, args, options));
    vi.spyOn(childProcess, 'spawnSync').mockImplementation((command, args, options) => command === 'fd'
      ? spawnSync(process.execPath, [shim, ...args ?? []], options) : spawnSync(command, args, options));
    syncBuiltinESMExports();
  }
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

it('completes remote commands and share modes without suggesting credentials', async () => {
  const controller = { snapshot: { cwd: tmpdir(), catalog: { commands: [] } } } as unknown as TuiSessionController;
  const provider = createCommandAutocomplete(controller); const options = { signal: new AbortController().signal };
  expect((await provider.getSuggestions(['/remo'], 0, 5, options))?.items).toContainEqual(expect.objectContaining({ value: 'remote' }));
  expect((await provider.getSuggestions(['/remote '], 0, 8, options))?.items.map(item => item.value)).toEqual([
    'status', 'on', 'off', 'login', 'logout', 'share all', 'share on-request', 'open', 'close',
  ]);
  const suggestions = await provider.getSuggestions(['/remote share o'], 0, 15, options);
  expect(suggestions?.items).toEqual([{ value: 'share on-request', label: 'share on-request' }]);
  expect(provider.applyCompletion(['/remote share o'], 0, 15, suggestions!.items[0]!, suggestions!.prefix)).toMatchObject({ lines: ['/remote share on-request'] });
});
