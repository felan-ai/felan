import type { ExtensionContext } from '@felan-ai/agent-core';
import {
  Key,
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

export interface DependencyInstallOption {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export async function selectDependencyInstallations(
  ctx: ExtensionContext,
  options: readonly DependencyInstallOption[],
): Promise<readonly string[] | undefined> {
  if (options.length === 0) return [];
  return ctx.ui.custom<readonly string[] | undefined>(
    (tui, theme, keybindings, done) => new DependencyInstallationChecklist(
      tui,
      theme,
      keybindings,
      options,
      done,
    ),
  );
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
