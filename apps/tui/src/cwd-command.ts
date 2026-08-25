import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { InteractiveMode } from '@earendil-works/pi-coding-agent';
import type {
  AutocompleteProvider,
  AutocompleteSuggestions,
  Editor,
} from '@earendil-works/pi-tui';

const CWD_COMMAND = '/cwd';
const CWD_DESCRIPTION = 'Start a new session in another directory';

interface CwdCommandEditor extends Pick<Editor, 'addToHistory' | 'setText'> {
  onSubmit?: (text: string) => void;
}

interface InteractiveModeCwdInternals {
  readonly defaultEditor: CwdCommandEditor;
  readonly editor: CwdCommandEditor;
  createBaseAutocompleteProvider(): AutocompleteProvider;
  getUserInput(): Promise<string>;
  setupEditorSubmitHandler(): void;
}

export interface InstallFelanCwdCommandOptions {
  readonly getCwd: () => string;
  readonly isIdle: () => boolean;
  readonly homeDir?: string;
}

export class CwdChangeRequested extends Error {
  constructor(readonly cwd: string) {
    super(`Start a new session in ${cwd}`);
    this.name = 'CwdChangeRequested';
  }
}

export function installFelanCwdCommand(
  mode: InteractiveMode,
  options: InstallFelanCwdCommandOptions,
): void {
  const internals = mode as unknown as InteractiveModeCwdInternals;
  if (
    typeof internals.createBaseAutocompleteProvider !== 'function'
    || typeof internals.getUserInput !== 'function'
    || typeof internals.setupEditorSubmitHandler !== 'function'
  ) {
    throw new Error('The installed Pi version does not expose a compatible built-in command surface');
  }

  const createBaseAutocompleteProvider = internals.createBaseAutocompleteProvider.bind(mode);
  internals.createBaseAutocompleteProvider = () => new CwdAutocompleteProvider(
    createBaseAutocompleteProvider(),
  );

  let requestedCwd: string | undefined;
  const getUserInput = internals.getUserInput.bind(mode);
  internals.getUserInput = async () => {
    const input = await getUserInput();
    if (requestedCwd === undefined) return input;
    const cwd = requestedCwd;
    requestedCwd = undefined;
    throw new CwdChangeRequested(cwd);
  };

  const setupEditorSubmitHandler = internals.setupEditorSubmitHandler.bind(mode);
  internals.setupEditorSubmitHandler = () => {
    setupEditorSubmitHandler();
    const submit = internals.defaultEditor.onSubmit;
    if (typeof submit !== 'function') {
      throw new Error('The installed Pi version did not install a compatible command submit handler');
    }

    internals.defaultEditor.onSubmit = (text) => {
      if (!isCwdCommand(text)) {
        submit(text);
        return;
      }
      if (!options.isIdle()) {
        mode.showWarning('Wait for the current response to finish before changing directories');
        internals.editor.setText(text);
        return;
      }

      try {
        requestedCwd = resolveCwdCommandTarget(
          text,
          options.getCwd(),
          options.homeDir ?? homedir(),
        );
      } catch (error) {
        internals.defaultEditor.addToHistory(text);
        internals.editor.setText(text);
        mode.showError(error instanceof Error ? error.message : String(error));
        return;
      }
      submit(text);
    };
  };
}

export function resolveCwdCommandTarget(
  command: string,
  cwd: string,
  homeDir: string = homedir(),
): string {
  const argument = cwdCommandArgument(command);
  const expanded = argument === '~'
    ? homeDir
    : argument.startsWith('~/') || argument.startsWith('~\\')
      ? resolve(homeDir, argument.slice(2))
      : argument;
  const target = resolve(cwd, expanded);

  let canonicalTarget: string;
  try {
    canonicalTarget = realpathSync(target);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(`Directory does not exist: ${argument}`);
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(`Directory is not accessible: ${argument}`);
    }
    throw new Error(`Cannot use directory ${argument}: ${errorMessage(error)}`);
  }

  try {
    if (!statSync(canonicalTarget).isDirectory()) {
      throw new Error(`Not a directory: ${argument}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message === `Not a directory: ${argument}`) throw error;
    throw new Error(`Cannot use directory ${argument}: ${errorMessage(error)}`);
  }
  return canonicalTarget;
}

function isCwdCommand(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === CWD_COMMAND || trimmed.startsWith(`${CWD_COMMAND} `);
}

function cwdCommandArgument(command: string): string {
  const trimmed = command.trim();
  if (!isCwdCommand(trimmed)) throw new Error(`Usage: ${CWD_COMMAND} <directory>`);
  let argument = trimmed.slice(CWD_COMMAND.length).trim();
  if (!argument) throw new Error(`Usage: ${CWD_COMMAND} <directory>`);

  const quote = argument[0];
  if (quote === '"' || quote === "'") {
    if (argument.length < 2 || argument.at(-1) !== quote) {
      throw new Error('Directory path has an unterminated quote');
    }
    argument = argument.slice(1, -1);
  }
  if (!argument) throw new Error(`Usage: ${CWD_COMMAND} <directory>`);
  return argument;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class CwdAutocompleteProvider implements AutocompleteProvider {
  readonly triggerCharacters: string[];

  constructor(private readonly current: AutocompleteProvider) {
    this.triggerCharacters = current.triggerCharacters ?? [];
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const currentLine = lines[cursorLine] ?? '';
    const textBeforeCursor = currentLine.slice(0, cursorCol);
    const argumentPrefix = getCwdArgumentPrefix(textBeforeCursor);
    if (argumentPrefix !== undefined) {
      const suggestions = await this.current.getSuggestions(
        [argumentPrefix],
        0,
        argumentPrefix.length,
        { ...options, force: true },
      );
      if (!suggestions) return null;
      const directories = suggestions.items.filter(({ label }) => label.endsWith('/'));
      return directories.length === 0
        ? null
        : { items: directories, prefix: suggestions.prefix };
    }

    const suggestions = await this.current.getSuggestions(lines, cursorLine, cursorCol, options);
    const commandPrefix = getCommandPrefix(textBeforeCursor);
    if (commandPrefix === undefined || !'cwd'.startsWith(commandPrefix.toLowerCase())) {
      return suggestions;
    }
    if (suggestions?.items.some(({ value }) => value === 'cwd')) return suggestions;

    return {
      items: [
        ...(suggestions?.items ?? []),
        { value: 'cwd', label: 'cwd', description: CWD_DESCRIPTION },
      ],
      prefix: suggestions?.prefix ?? textBeforeCursor,
    };
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: Parameters<AutocompleteProvider['applyCompletion']>[3],
    prefix: string,
  ): ReturnType<AutocompleteProvider['applyCompletion']> {
    return this.current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }

  shouldTriggerFileCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): boolean {
    return this.current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
  }
}

function getCommandPrefix(textBeforeCursor: string): string | undefined {
  if (!textBeforeCursor.startsWith('/') || /\s/u.test(textBeforeCursor)) return undefined;
  return textBeforeCursor.slice(1);
}

function getCwdArgumentPrefix(textBeforeCursor: string): string | undefined {
  const match = /^\/cwd\s+(.*)$/u.exec(textBeforeCursor);
  return match?.[1];
}
