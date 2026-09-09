import type { InteractiveMode } from '@earendil-works/pi-coding-agent';
import type {
  AutocompleteProvider,
  AutocompleteSuggestions,
  Editor,
} from '@earendil-works/pi-tui';

const RESTART_COMMAND = '/restart';
const RESTART_DESCRIPTION = 'Restart Felan and resume this session';

interface RestartCommandEditor extends Pick<Editor, 'addToHistory' | 'setText'> {
  onSubmit?: (text: string) => void;
}

interface InteractiveModeRestartInternals {
  readonly defaultEditor: RestartCommandEditor;
  readonly editor: RestartCommandEditor;
  createBaseAutocompleteProvider(): AutocompleteProvider;
  getUserInput(): Promise<string>;
  setupEditorSubmitHandler(): void;
}

export interface InstallFelanRestartCommandOptions {
  readonly isIdle: () => boolean;
}

export class RestartRequested extends Error {
  constructor() {
    super('Restart Felan and resume this session');
    this.name = 'RestartRequested';
  }
}

export function installFelanRestartCommand(
  mode: InteractiveMode,
  options: InstallFelanRestartCommandOptions,
): void {
  const internals = mode as unknown as InteractiveModeRestartInternals;
  if (
    typeof internals.createBaseAutocompleteProvider !== 'function'
    || typeof internals.getUserInput !== 'function'
    || typeof internals.setupEditorSubmitHandler !== 'function'
  ) {
    throw new Error('The installed Pi version does not expose a compatible built-in command surface');
  }

  const createBaseAutocompleteProvider = internals.createBaseAutocompleteProvider.bind(mode);
  internals.createBaseAutocompleteProvider = () => new RestartAutocompleteProvider(
    createBaseAutocompleteProvider(),
  );

  let requested = false;
  const getUserInput = internals.getUserInput.bind(mode);
  internals.getUserInput = async () => {
    const input = await getUserInput();
    if (!requested) return input;
    requested = false;
    throw new RestartRequested();
  };

  const setupEditorSubmitHandler = internals.setupEditorSubmitHandler.bind(mode);
  internals.setupEditorSubmitHandler = () => {
    setupEditorSubmitHandler();
    const submit = internals.defaultEditor.onSubmit;
    if (typeof submit !== 'function') {
      throw new Error('The installed Pi version did not install a compatible command submit handler');
    }

    internals.defaultEditor.onSubmit = (text) => {
      if (!isRestartInvocation(text)) {
        submit(text);
        return;
      }
      if (text.trim() !== RESTART_COMMAND) {
        internals.defaultEditor.addToHistory(text);
        internals.editor.setText(text);
        mode.showError(`Usage: ${RESTART_COMMAND}`);
        return;
      }
      if (!options.isIdle()) {
        mode.showWarning('Wait for the current response to finish before restarting Felan');
        internals.editor.setText(text);
        return;
      }

      requested = true;
      submit(text);
    };
  };
}

function isRestartInvocation(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === RESTART_COMMAND || trimmed.startsWith(`${RESTART_COMMAND} `);
}

class RestartAutocompleteProvider implements AutocompleteProvider {
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
    const suggestions = await this.current.getSuggestions(lines, cursorLine, cursorCol, options);
    const currentLine = lines[cursorLine] ?? '';
    const textBeforeCursor = currentLine.slice(0, cursorCol);
    const commandPrefix = getCommandPrefix(textBeforeCursor);
    if (commandPrefix === undefined || !'restart'.startsWith(commandPrefix.toLowerCase())) {
      return suggestions;
    }
    if (suggestions?.items.some(({ value }) => value === 'restart')) return suggestions;

    return {
      items: [
        ...(suggestions?.items ?? []),
        { value: 'restart', label: 'restart', description: RESTART_DESCRIPTION },
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
