import type { ExtensionContext } from '@felan-ai/agent-core';
import {
  Key,
  Loader,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type KeybindingsManager,
  type TUI,
} from '@earendil-works/pi-tui';

type Theme = ExtensionContext['ui']['theme'];

const INLINE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;
const FELAN_INSTALL_FRAMES = ['⠐◉ ', '⠈◉ ', ' ◉⠁', ' ◉⠂', ' ◉⠄', '⠠◉ '];
const FELAN_INSTALL_INTERVAL_MS = 120;

export interface DependencyInstallOption {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export interface DependencyInstallProgress {
  setMessage(message: string): void;
}

export async function runDependencyOnboarding(
  ctx: ExtensionContext,
  options: readonly DependencyInstallOption[],
  afterSelection: (selected: readonly string[], progress: DependencyInstallProgress) => Promise<void>,
): Promise<boolean> {
  if (options.length === 0) {
    await afterSelection([], { setMessage() {} });
    return true;
  }
  let afterSelectionError: unknown;
  const completed = await ctx.ui.custom<boolean>((tui, theme, keybindings, done) => {
    const view = new DependencyOnboardingView(tui, theme, keybindings, options, {
      onCancel: () => done(false),
      onSubmit: (selected) => {
        void (async () => {
          try {
            if (selected.length > 0) view.beginInstall('Installing...');
            await afterSelection(selected, {
              setMessage: (message) => view.setInstallMessage(message),
            });
            done(true);
          } catch (error) {
            afterSelectionError = error;
            done(true);
          }
        })();
      },
    });
    return view;
  });
  if (afterSelectionError !== undefined) throw afterSelectionError;
  return completed === true;
}

export class DependencyInstallProgressLoader extends Loader {
  constructor(tui: Pick<TUI, 'requestRender'>, theme: Theme, message: string) {
    super(
      tui as TUI,
      (text) => theme.fg('accent', text),
      (text) => theme.fg('muted', text),
      message,
      {
        frames: FELAN_INSTALL_FRAMES.map((frame) => theme.fg('accent', frame)),
        intervalMs: FELAN_INSTALL_INTERVAL_MS,
      },
    );
  }

  dispose(): void {
    this.stop();
  }
}

export class DependencyOnboardingView implements Component {
  readonly #checklist: DependencyInstallationChecklist;
  #loader: DependencyInstallProgressLoader | undefined;

  constructor(
    private readonly tui: Pick<TUI, 'requestRender'>,
    private readonly theme: Theme,
    keybindings: KeybindingsManager,
    options: readonly DependencyInstallOption[],
    handlers: {
      onCancel: () => void;
      onSubmit: (selected: readonly string[]) => void;
    },
  ) {
    this.#checklist = new DependencyInstallationChecklist(
      tui,
      theme,
      keybindings,
      options,
      (selection) => {
        if (this.#loader) return;
        if (selection === undefined) handlers.onCancel();
        else handlers.onSubmit(selection);
      },
    );
  }

  beginInstall(message: string): void {
    this.#loader?.dispose();
    this.#loader = new DependencyInstallProgressLoader(this.tui, this.theme, message);
    this.tui.requestRender();
  }

  setInstallMessage(message: string): void {
    this.#loader?.setMessage(message);
  }

  invalidate(): void {
    this.#loader?.invalidate();
  }

  dispose(): void {
    this.#loader?.dispose();
  }

  render(width: number): string[] {
    return this.#loader ? this.#loader.render(width) : this.#checklist.render(width);
  }

  handleInput(data: string): void {
    if (this.#loader) return;
    this.#checklist.handleInput(data);
  }
}

export class DependencyInstallationChecklist implements Component {
  readonly #checked = new Set<string>();
  #selectedIndex = 0;
  #closed = false;

  constructor(
    private readonly tui: Pick<TUI, 'requestRender'>,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly options: readonly DependencyInstallOption[],
    private readonly done: (selection: readonly string[] | undefined) => void,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const renderWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80;
    const lines = [
      this.theme.fg('accent', this.theme.bold('Install optional extensions')),
      this.theme.fg('text', 'Check the extensions whose reviewed dependencies Felan Code may install.'),
      this.theme.fg('muted', 'Unchecked extensions will use their safe fallback. Escape decides later.'),
      '',
    ];

    for (const [index, option] of this.options.entries()) {
      const active = index === this.#selectedIndex;
      const pointer = active ? this.theme.fg('accent', '→') : ' ';
      const checkbox = this.#checked.has(option.id)
        ? this.theme.fg('success', '[✓]')
        : this.theme.fg('dim', '[ ]');
      const label = this.theme.fg(active ? 'accent' : 'text', this.theme.bold(inlineText(option.label)));
      lines.push(truncateToWidth(`${pointer} ${checkbox} ${label}`, renderWidth, ''));
      for (const line of wrapTextWithAnsi(inlineText(option.description), Math.max(1, renderWidth - 4))) {
        lines.push(truncateToWidth(`    ${this.theme.fg('muted', line)}`, renderWidth, ''));
      }
    }

    lines.push(
      '',
      this.theme.fg('dim', 'Space toggle • ↑↓ navigate • Enter continue • Esc decide later'),
    );
    return lines.map((line) => truncateToWidth(line, renderWidth, '', true));
  }

  handleInput(data: string): void {
    if (this.#closed) return;
    if (this.keybindings.matches(data, 'tui.select.cancel') || matchesKey(data, Key.escape)) {
      this.#finish(undefined);
      return;
    }
    if (this.options.length === 0) return;
    if (this.keybindings.matches(data, 'tui.select.up') || matchesKey(data, Key.up)) {
      this.#selectedIndex = this.#selectedIndex === 0 ? this.options.length - 1 : this.#selectedIndex - 1;
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, 'tui.select.down') || matchesKey(data, Key.down)) {
      this.#selectedIndex = this.#selectedIndex === this.options.length - 1 ? 0 : this.#selectedIndex + 1;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.space)) {
      const selected = this.options[this.#selectedIndex];
      if (!selected) return;
      if (this.#checked.has(selected.id)) this.#checked.delete(selected.id);
      else this.#checked.add(selected.id);
      this.tui.requestRender();
      return;
    }
    if (
      this.keybindings.matches(data, 'tui.select.confirm')
      || this.keybindings.matches(data, 'tui.input.submit')
      || matchesKey(data, Key.enter)
      || matchesKey(data, Key.return)
    ) {
      this.#finish(this.options.filter((option) => this.#checked.has(option.id)).map((option) => option.id));
    }
  }

  #finish(selection: readonly string[] | undefined): void {
    if (this.#closed) return;
    this.#closed = true;
    this.done(selection);
  }
}

function inlineText(value: string): string {
  return stripTerminalSequences(value)
    .replace(INLINE_CONTROL_CHARACTERS, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}
