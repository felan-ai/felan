import { resolve } from 'node:path';
import {
  Key,
  matchesKey,
  ProcessTerminal,
  TuiMainScreen,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TUI,
} from '@earendil-works/pi-tui';
import {
  applyProjectTrustChoice,
  createFelanProjectTrustStore,
  getFelanProjectTrustParentPath,
  type ProjectTrustDecision,
  type ProjectTrustPromptChoice,
  type ProjectTrustStore,
} from './project-trust.js';

export interface ProjectTrustPromptOption {
  readonly id: Exclude<ProjectTrustPromptChoice, 'skip'>;
  readonly label: string;
  readonly description: string;
}

export function projectTrustPromptOptions(cwd: string): readonly ProjectTrustPromptOption[] {
  const resolved = resolve(cwd);
  const parent = getFelanProjectTrustParentPath(resolved);
  const options: ProjectTrustPromptOption[] = [
    {
      id: 'trust',
      label: 'Trust this folder',
      description: `Load project Pi extensions from ${resolved}. Remember this decision.`,
    },
  ];
  if (parent !== undefined) {
    options.push({
      id: 'trust-parent',
      label: 'Trust parent folder',
      description: `Trust ${parent} and load project Pi extensions here. Remember this decision.`,
    });
  }
  options.push({
    id: 'deny',
    label: 'Do not trust',
    description: 'Skip project Pi extensions in this folder. Remember this decision.',
  });
  return options;
}

export async function promptProjectTrust(options: {
  readonly cwd: string;
  readonly agentDir: string;
  readonly store?: ProjectTrustStore;
  readonly showHardwareCursor?: boolean;
  readonly clearOnShrink?: boolean;
  readonly createTui?: () => TUI;
  readonly prompt?: (choices: readonly ProjectTrustPromptOption[]) => Promise<ProjectTrustPromptChoice>;
}): Promise<ProjectTrustDecision> {
  const store = options.store ?? createFelanProjectTrustStore(options.agentDir);
  const choices = projectTrustPromptOptions(options.cwd);
  const choice = await (options.prompt ?? ((items) => selectProjectTrust(items, options)))(choices);
  return applyProjectTrustChoice(store, options.cwd, choice);
}

async function selectProjectTrust(
  choices: readonly ProjectTrustPromptOption[],
  options: {
    readonly agentDir: string;
    readonly showHardwareCursor?: boolean;
    readonly clearOnShrink?: boolean;
    readonly createTui?: () => TUI;
  },
): Promise<ProjectTrustPromptChoice> {
  const ui = options.createTui?.() ?? new TuiMainScreen(
    new ProcessTerminal(),
    options.showHardwareCursor,
    options.agentDir,
  );
  if (options.clearOnShrink !== undefined) ui.setClearOnShrink(options.clearOnShrink);

  return new Promise((resolveChoice) => {
    let settled = false;
    const finish = (choice: ProjectTrustPromptChoice) => {
      if (settled) return;
      settled = true;
      ui.stop();
      resolveChoice(choice);
    };
    const prompt = new ProjectTrustPrompt(
      { requestRender: () => ui.requestRender() },
      choices,
      finish,
    );
    ui.addChild(prompt);
    ui.setFocus(prompt);
    ui.start();
  });
}

export class ProjectTrustPrompt implements Component, Focusable {
  #selectedIndex = 0;
  #closed = false;
  #focused = false;

  get focused(): boolean {
    return this.#focused;
  }

  set focused(value: boolean) {
    this.#focused = value;
  }

  constructor(
    private readonly tui: Pick<TUI, 'requestRender'>,
    private readonly options: readonly ProjectTrustPromptOption[],
    private readonly done: (choice: ProjectTrustPromptChoice) => void,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const renderWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80;
    const lines = [
      'Trust project Pi extensions?',
      'This folder has .pi/extensions. Trusted folders load those modules with your permissions.',
      'Escape skips this session without saving a decision.',
      '',
    ];

    for (const [index, option] of this.options.entries()) {
      const pointer = index === this.#selectedIndex ? '→' : ' ';
      lines.push(truncateToWidth(`${pointer} ${option.label}`, renderWidth, ''));
      for (const line of wrapTextWithAnsi(option.description, Math.max(1, renderWidth - 4))) {
        lines.push(truncateToWidth(`    ${line}`, renderWidth, ''));
      }
    }

    lines.push(
      '',
      '↑↓ navigate • Enter confirm • Esc skip this session',
    );
    return lines.map((line) => truncateToWidth(line, renderWidth, '', true));
  }

  handleInput(data: string): void {
    if (this.#closed) return;
    if (matchesKey(data, Key.escape)) {
      this.#finish('skip');
      return;
    }
    if (this.options.length === 0) return;
    if (matchesKey(data, Key.up)) {
      this.#selectedIndex = this.#selectedIndex === 0 ? this.options.length - 1 : this.#selectedIndex - 1;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.#selectedIndex = this.#selectedIndex === this.options.length - 1 ? 0 : this.#selectedIndex + 1;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      const selected = this.options[this.#selectedIndex];
      if (selected) this.#finish(selected.id);
    }
  }

  #finish(choice: ProjectTrustPromptChoice): void {
    if (this.#closed) return;
    this.#closed = true;
    this.done(choice);
  }
}
