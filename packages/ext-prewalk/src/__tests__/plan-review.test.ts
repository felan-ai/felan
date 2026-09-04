import type { ExtensionContext } from '@felan-ai/agent-core';
import {
  KeybindingsManager,
  TuiAltScreen,
  TUI_KEYBINDINGS,
  visibleWidth,
  type Terminal,
} from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import {
  PlanReview,
  PLAN_REVIEW_OVERLAY_OPTIONS,
  PLAN_REVIEW_OPTIONS,
  sanitizePlanForDisplay,
} from '../plan-review.js';

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as ExtensionContext['ui']['theme'];

function createHarness(rows = 12, columns = 64) {
  const tui = { terminal: { rows, columns }, requestRender: vi.fn() };
  const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
  let result: string | undefined;
  const review = new PlanReview(
    tui as never,
    theme,
    keybindings,
    [
      '# Plan',
      '',
      '**Bold** and *italic* with [a link](https://example.com).',
      '',
      '> A useful quote',
      '',
      '```ts',
      'const answer = 42;',
      '```',
      '',
      ...Array.from({ length: 24 }, (_, index) => `Plan line ${index + 1}`),
    ].join('\n'),
    (action) => { result = action; },
  );
  return { review, tui, get result() { return result; } };
}

function legacyWheel(button: 64 | 65): string {
  return `\x1b[M${String.fromCharCode(button + 32, 33, 33)}`;
}

class TestTerminal implements Terminal {
  readonly columns = 64;
  readonly rows = 12;
  readonly kittyProtocolActive = false;
  #onInput?: (data: string) => void;

  start(onInput: (data: string) => void): void { this.#onInput = onInput; }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  send(data: string): void { this.#onInput?.(data); }
}

describe('PlanReview', () => {
  it('renders Markdown in a bounded fullscreen layout with fixed actions', () => {
    const harness = createHarness();
    const lines = harness.review.render(64);
    const output = lines.join('\n');

    expect(lines).toHaveLength(12);
    expect(lines.every((line) => visibleWidth(line) === 64)).toBe(true);
    expect(output).toContain('Plan');
    expect(output).toContain('Bold');
    expect(output).toContain('Approve plan');
    expect(output).toContain('Provide feedback');
    expect(output).toContain('Cancel Prewalk');
    expect(output).toContain('scroll');
    expect(output).not.toContain('Plan line 24');
  });

  it('scrolls the Markdown pane without moving the fixed choices', () => {
    const harness = createHarness();
    const first = harness.review.render(64).join('\n');
    harness.review.handleInput('\x1b[6~');
    const middle = harness.review.render(64).join('\n');
    harness.review.handleInput('\x1b[4~');
    const last = harness.review.render(64).join('\n');

    expect(first).toContain('Approve plan');
    expect(middle).toContain('Approve plan');
    expect(last).toContain('Approve plan');
    expect(middle).not.toEqual(first);
    expect(last).toContain('Plan line 24');
    expect(last).toContain('lines');
  });

  it('scrolls the Markdown pane with SGR and legacy mouse-wheel input', () => {
    const harness = createHarness();
    const first = harness.review.render(64).join('\n');
    harness.tui.requestRender.mockClear();

    harness.review.handleInput('\x1b[<65;20;5M');
    const afterSgrWheelDown = harness.review.render(64).join('\n');

    expect(first).toContain('lines 1-4/34');
    expect(afterSgrWheelDown).toContain('lines 2-5/34');
    expect(afterSgrWheelDown).not.toEqual(first);
    expect(afterSgrWheelDown).toContain('Approve plan');
    expect(afterSgrWheelDown).toContain('Provide feedback');
    expect(afterSgrWheelDown).toContain('Cancel Prewalk');
    expect(harness.tui.requestRender).toHaveBeenCalledTimes(1);

    harness.review.handleInput(legacyWheel(64));
    expect(harness.review.render(64).join('\n')).toEqual(first);
    expect(harness.tui.requestRender).toHaveBeenCalledTimes(2);
  });

  it('ignores non-wheel mouse input', () => {
    const harness = createHarness();
    const first = harness.review.render(64).join('\n');
    harness.tui.requestRender.mockClear();

    harness.review.handleInput('\x1b[<0;20;5M');

    expect(harness.review.render(64).join('\n')).toEqual(first);
    expect(harness.tui.requestRender).not.toHaveBeenCalled();
  });

  it('receives wheel input through a focused fullscreen TUI overlay', () => {
    const terminal = new TestTerminal();
    const tui = new TuiAltScreen(terminal);
    const review = new PlanReview(
      tui,
      theme,
      new KeybindingsManager(TUI_KEYBINDINGS),
      ['# Plan', '', ...Array.from({ length: 40 }, (_, index) => `Plan line ${index + 1}`)].join('\n'),
      vi.fn(),
    );
    tui.showOverlay(review, PLAN_REVIEW_OVERLAY_OPTIONS);
    tui.start();

    try {
      tui.renderNow(true);
      const first = review.render(terminal.columns).join('\n');
      terminal.send('\x1b[<65;20;5M');
      const afterWheelDown = review.render(terminal.columns).join('\n');

      expect(first).toContain('lines 1-4/42');
      expect(afterWheelDown).toContain('lines 2-5/42');
      expect(afterWheelDown).toContain('Approve plan');
      expect(afterWheelDown).toContain('Cancel Prewalk');
    } finally {
      tui.stop();
    }
  });

  it('keeps action order and returns the selected action', () => {
    const harness = createHarness();
    const output = harness.review.render(64).join('\n');
    expect(output.indexOf(PLAN_REVIEW_OPTIONS[0])).toBeLessThan(output.indexOf(PLAN_REVIEW_OPTIONS[1]));
    expect(output.indexOf(PLAN_REVIEW_OPTIONS[1])).toBeLessThan(output.indexOf(PLAN_REVIEW_OPTIONS[2]));

    harness.review.handleInput('\x1b[B');
    harness.review.handleInput('\r');
    expect(harness.result).toBe('Provide feedback');
  });

  it('dismisses on Escape and remains width-safe on tiny terminals', () => {
    const harness = createHarness(3, 8);
    const lines = harness.review.render(8);
    expect(lines.every((line) => visibleWidth(line) <= 8)).toBe(true);
    harness.review.handleInput('\x1b');
    expect(harness.result).toBeUndefined();
    expect(harness.tui.requestRender).not.toHaveBeenCalled();
  });

  it('reflows and clamps the scroll position after a terminal resize', () => {
    const harness = createHarness(16, 64);
    harness.review.render(64);
    harness.review.handleInput('\x1b[4~');
    harness.tui.terminal.rows = 6;
    const lines = harness.review.render(32);

    expect(lines).toHaveLength(6);
    expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
    expect(lines.join('\n')).toContain('Approve plan');
  });

  it('renders the maximum accepted plan without exceeding the overlay height', () => {
    const tui = { terminal: { rows: 24, columns: 80 }, requestRender: vi.fn() };
    const review = new PlanReview(
      tui as never,
      theme,
      new KeybindingsManager(TUI_KEYBINDINGS),
      `# Plan\n\n${'A'.repeat(31_990)}`,
      vi.fn(),
    );

    expect(review.render(80)).toHaveLength(24);
  });
});

describe('sanitizePlanForDisplay', () => {
  it('removes terminal controls while preserving Markdown and line structure', () => {
    const plan = '\u001b]52;c;secret\u0007# Heading\r\n\u0007- Keep Unicode ✓\u001b[31m\n\tcode';
    expect(sanitizePlanForDisplay(plan)).toBe('# Heading\n - Keep Unicode ✓\n\tcode');
  });
});
