import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InteractiveMode } from '@earendil-works/pi-coding-agent';
import type { AutocompleteProvider } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CwdChangeRequested,
  installFelanCwdCommand,
  resolveCwdCommandTarget,
} from '../src/cwd-command.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('Felan /cwd command', () => {
  it('resolves relative, quoted, home, and absolute paths', async () => {
    const root = await temporaryDirectory();
    const current = join(root, 'current');
    const target = join(current, 'target project');
    const home = join(root, 'home');
    const homeTarget = join(home, 'target');
    await Promise.all([current, target, homeTarget].map((path) => mkdir(path, { recursive: true })));

    expect(resolveCwdCommandTarget('/cwd "../current/target project"', current)).toBe(realpathSync(target));
    expect(resolveCwdCommandTarget('/cwd ~/target', current, home)).toBe(realpathSync(homeTarget));
    expect(resolveCwdCommandTarget(`/cwd ${target}`, current)).toBe(realpathSync(target));
  });

  it('rejects missing, non-directory, and malformed targets', async () => {
    const root = await temporaryDirectory();
    const current = join(root, 'current');
    const file = join(current, 'file');
    await mkdir(current, { recursive: true });
    await writeFile(file, 'content');

    expect(() => resolveCwdCommandTarget('/cwd', current)).toThrow('Usage: /cwd <directory>');
    expect(() => resolveCwdCommandTarget('/cwd missing', current)).toThrow('Directory does not exist');
    expect(() => resolveCwdCommandTarget('/cwd file', current)).toThrow('Not a directory');
    expect(() => resolveCwdCommandTarget('/cwd "current', current)).toThrow('unterminated quote');
  });

  it('adds /cwd and filters its argument completion to directories', async () => {
    const current: AutocompleteProvider = {
      triggerCharacters: [],
      getSuggestions: async (lines) => lines[0] === '.'
        ? {
          prefix: '.',
          items: [
            { value: './folder/', label: './folder/' },
            { value: './file', label: './file' },
          ],
        }
        : null,
      applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => ({
        lines: [lines[cursorLine]!.replace(prefix, item.value)],
        cursorLine,
        cursorCol,
      }),
    };
    const internals = fakeMode(current);
    installFelanCwdCommand(internals.mode, {
      getCwd: () => '/workspace',
      isIdle: () => true,
    });
    internals.setupEditorSubmitHandler();

    const provider = (internals.mode as unknown as {
      createBaseAutocompleteProvider(): AutocompleteProvider;
    }).createBaseAutocompleteProvider();
    await expect(provider.getSuggestions(['/c'], 0, 2, { signal: new AbortController().signal }))
      .resolves.toEqual({
        prefix: '/c',
        items: [{ value: 'cwd', label: 'cwd', description: 'Start a new session in another directory' }],
      });
    await expect(provider.getSuggestions(['/cwd .'], 0, 7, { signal: new AbortController().signal }))
      .resolves.toEqual({
        prefix: '.',
        items: [{ value: './folder/', label: './folder/' }],
      });
  });

  it('raises a typed restart request only after an idle valid submission', async () => {
    const internals = fakeMode({
      triggerCharacters: [],
      getSuggestions: async () => null,
      applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
    });
    installFelanCwdCommand(internals.mode, {
      getCwd: () => '/workspace',
      isIdle: () => true,
    });
    internals.setupEditorSubmitHandler();
    internals.modeInternals.defaultEditor.onSubmit!('/cwd /tmp');
    await expect((internals.mode as unknown as { getUserInput(): Promise<string> }).getUserInput()).rejects.toEqual(
      new CwdChangeRequested(realpathSync('/tmp')),
    );
  });

  it('leaves an invalid or busy command in the editor', async () => {
    const internals = fakeMode({
      triggerCharacters: [],
      getSuggestions: async () => null,
      applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
    });
    let idle = false;
    installFelanCwdCommand(internals.mode, {
      getCwd: () => '/workspace',
      isIdle: () => idle,
    });
    internals.setupEditorSubmitHandler();
    internals.modeInternals.defaultEditor.onSubmit!('/cwd /tmp');
    expect(internals.warning).toContain('Wait for the current response');
    expect(internals.modeInternals.editor.setText).toHaveBeenCalledWith('/cwd /tmp');

    idle = true;
    internals.modeInternals.defaultEditor.onSubmit!('/cwd /does-not-exist');
    expect(internals.error).toContain('Directory does not exist');
  });
});

function fakeMode(current: AutocompleteProvider) {
  let submitted = '';
  const defaultEditor = {
    onSubmit: undefined as ((text: string) => void) | undefined,
    addToHistory: vi.fn(),
    setText: vi.fn(),
  };
  const modeInternals = {
    defaultEditor,
    editor: defaultEditor,
    createBaseAutocompleteProvider: () => current,
    getUserInput: async () => submitted,
    setupEditorSubmitHandler: () => {
      defaultEditor.onSubmit = (text) => {
        submitted = text;
      };
    },
  };
  const mode = {
    showWarning: vi.fn((message: string) => { result.warning = message; }),
    showError: vi.fn((message: string) => { result.error = message; }),
  } as unknown as InteractiveMode;
  Object.assign(mode, modeInternals);
  const result = {
    mode,
    modeInternals,
    warning: '',
    error: '',
    setupEditorSubmitHandler: () => (
      mode as unknown as { setupEditorSubmitHandler(): void }
    ).setupEditorSubmitHandler(),
  };
  return result;
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-tui-cwd-'));
  temporaryPaths.push(path);
  return path;
}
