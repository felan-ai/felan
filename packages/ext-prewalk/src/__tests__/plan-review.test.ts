import type { ExtensionContext } from '@felan-ai/agent-core';
import {
  CURSOR_MARKER,
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  TuiAltScreen,
  TUI_KEYBINDINGS,
  visibleWidth,
  type Terminal,
  type TuiMouseEvent,
} from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import {
  PlanReview,
  PLAN_REVIEW_OVERLAY_OPTIONS,
  PLAN_REVIEW_OPTIONS,
  presentPlanReview,
  sanitizePlanForDisplay,
  type PlanReviewResult,
} from '../plan-review.js';

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as ExtensionContext['ui']['theme'];

function createHarness(rows = 12, columns = 64, keybindings = new KeybindingsManager(TUI_KEYBINDINGS)) {
  const tui = { terminal: { rows, columns }, requestRender: vi.fn() };
  let result: PlanReviewResult | undefined;
  const done = vi.fn((value: PlanReviewResult | undefined) => { result = value; });
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
    done,
  );
  review.focused = true;
  return { review, tui, done, get result() { return result; } };
}

function openFeedback(review: PlanReview): void {
  review.handleInput('\x1b[B');
  review.handleInput('\r');
}

function legacyWheel(button: 64 | 65): string {
  return `\x1b[M${String.fromCharCode(button + 32, 33, 33)}`;
}

function mouseEvent(x: number, y: number, overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
  return {
    type: 'click', button: 'left', x, y, screenX: x, screenY: y,
    width: 64, height: 12, shift: false, alt: false, ctrl: false,
    ...overrides,
  };
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

  it('keeps feedback focused and the plan visible through the fullscreen overlay', () => {
    const terminal = new TestTerminal();
    const tui = new TuiAltScreen(terminal);
    const done = vi.fn();
    const review = new PlanReview(
      tui,
      theme,
      new KeybindingsManager(TUI_KEYBINDINGS),
      '# Plan\n\nKeep the public API.',
      done,
    );
    tui.showOverlay(review, PLAN_REVIEW_OVERLAY_OPTIONS);
    tui.start();

    try {
      tui.renderNow(true);
      terminal.send('\x1b[B');
      terminal.send('\r');
      terminal.send('Add tests.');
      terminal.send('\x1b[13;2~');
      terminal.send('Update docs.');
      tui.renderNow(true);
      const output = review.render(terminal.columns).join('\n');

      expect(review.focused).toBe(true);
      expect(output).toContain('Keep the public API.');
      expect(output).toContain('Add tests.');
      expect(output).toContain('Update docs.');
      expect(output).toContain(CURSOR_MARKER);
      expect(done).not.toHaveBeenCalled();
      const feedbackRow = review.render(terminal.columns).findIndex((line) => line.includes('Add tests.'));
      terminal.send(`\x1b[<0;5;${feedbackRow + 1}M`);
      terminal.send(`\x1b[<0;5;${feedbackRow + 1}m`);
      terminal.send('!');
      expect(review.focused).toBe(true);
      terminal.send('\r');
      expect(done).toHaveBeenCalledExactlyOnceWith({
        action: 'Provide feedback', feedback: 'Add! tests.\nUpdate docs.',
      });
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
    harness.review.handleInput('\x1b[B');
    harness.review.handleInput('\r');
    expect(harness.result).toEqual({ action: 'Cancel Prewalk' });
  });

  it('edits multiline feedback below the plan using the standard editor keys', () => {
    const harness = createHarness(24, 80);
    openFeedback(harness.review);
    harness.review.handleInput('Keep the API unchanged.');
    harness.review.handleInput('\x1b[13;2~');
    harness.review.handleInput('Add tests.');
    harness.review.handleInput('\n');
    harness.review.handleInput('Update docs.');
    const output = harness.review.render(80).join('\n');

    expect(harness.done).not.toHaveBeenCalled();
    expect(output).toContain('Bold');
    expect(output.indexOf('Bold')).toBeLessThan(output.indexOf('Feedback'));
    expect(output).toContain('Keep the API unchanged.');
    expect(output).toContain('Add tests.');
    expect(output).toContain('Update docs.');
    expect(output).toContain('shift+enter/ctrl+j newline');
    expect(output).toContain(CURSOR_MARKER);
    expect(output).not.toContain('Approve plan');

    harness.review.handleInput('\r');
    harness.review.handleInput('\r');
    expect(harness.done).toHaveBeenCalledExactlyOnceWith({
      action: 'Provide feedback',
      feedback: 'Keep the API unchanged.\nAdd tests.\nUpdate docs.',
    });
  });

  it('preserves pasted line breaks, including expanded large pastes', () => {
    const harness = createHarness();
    const feedback = Array.from({ length: 20 }, (_, index) => `Change ${index + 1}`).join('\n\n');
    openFeedback(harness.review);
    harness.review.handleInput(`\x1b[200~${feedback}\x1b[201~`);
    expect(harness.done).not.toHaveBeenCalled();
    harness.review.handleInput('\r');
    expect(harness.result).toEqual({ action: 'Provide feedback', feedback });
  });

  it('keeps the draft when returning to choices and ignores empty submissions', () => {
    const harness = createHarness();
    openFeedback(harness.review);
    harness.review.handleInput('  ');
    harness.review.handleInput('\r');
    expect(harness.done).not.toHaveBeenCalled();
    harness.review.handleInput('Keep this draft.');
    harness.review.handleInput('\x1b');
    expect(harness.done).not.toHaveBeenCalled();
    expect(harness.review.render(64).join('\n')).toContain('→ Provide feedback');
    expect(harness.review.render(64).join('\n')).not.toContain(CURSOR_MARKER);
    harness.review.handleInput('\r');
    expect(harness.review.render(64).join('\n')).toContain('Keep this draft.');
    harness.review.handleInput('\r');
    expect(harness.result).toEqual({ action: 'Provide feedback', feedback: 'Keep this draft.' });
  });

  it('can approve or dismiss after returning from feedback', () => {
    const approval = createHarness();
    openFeedback(approval.review);
    approval.review.handleInput('Discard this draft.');
    approval.review.handleInput('\x1b');
    approval.review.handleInput('\x1b[A');
    approval.review.handleInput('\r');
    expect(approval.result).toEqual({ action: 'Approve plan' });

    const dismissal = createHarness();
    openFeedback(dismissal.review);
    dismissal.review.handleInput('\x1b');
    dismissal.review.handleInput('\x1b');
    expect(dismissal.done).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('scrolls the plan without consuming editor navigation or changing feedback', () => {
    const harness = createHarness();
    openFeedback(harness.review);
    harness.review.handleInput('First');
    harness.review.handleInput('\n');
    harness.review.handleInput('jk draft');
    const initial = harness.review.render(64).join('\n');
    harness.review.handleInput('\x1b[6~');
    const scrolled = harness.review.render(64).join('\n');
    expect(scrolled).not.toEqual(initial);
    expect(scrolled).toContain('jk draft');
    harness.review.handleInput('\x1b[5~');
    expect(harness.review.render(64).join('\n')).toEqual(initial);
    harness.review.handleInput('\x1b[<65;20;5M');
    expect(harness.review.render(64).join('\n')).not.toEqual(initial);
    harness.review.handleInput(legacyWheel(64));
    expect(harness.review.render(64).join('\n')).toEqual(initial);

    harness.review.handleInput('\x1b[H');
    harness.review.handleInput('\x04');
    harness.review.handleInput('\x1b[F');
    harness.review.handleInput('\x15');
    harness.review.handleInput('Second');
    harness.review.handleInput('\x1b[A');
    harness.review.handleInput('!');
    harness.review.handleInput('\r');
    expect(harness.result).toEqual({ action: 'Provide feedback', feedback: 'First!\nSecond' });
  });

  it('honors configured submit and newline keys and displays their hints', () => {
    const previousKeybindings = getKeybindings();
    const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
      'tui.input.newLine': 'enter',
      'tui.input.submit': 'ctrl+s',
    });
    setKeybindings(keybindings);
    try {
      const harness = createHarness(24, 80, keybindings);
      openFeedback(harness.review);
      harness.review.handleInput('First');
      harness.review.handleInput('\r');
      harness.review.handleInput('Second');
      expect(harness.done).not.toHaveBeenCalled();
      expect(harness.review.render(80).join('\n')).toContain('ctrl+s send · enter newline');
      harness.review.handleInput('\x13');
      expect(harness.result).toEqual({ action: 'Provide feedback', feedback: 'First\nSecond' });
    } finally {
      setKeybindings(previousKeybindings);
    }
  });

  it('keeps the editor cursor visible through constrained resizing and focus changes', () => {
    const harness = createHarness(24, 80);
    openFeedback(harness.review);
    for (let index = 0; index < 12; index += 1) {
      harness.review.handleInput(`Feedback ${index}`);
      harness.review.handleInput('\n');
    }
    for (const [rows, width] of [[24, 80], [10, 32], [6, 16], [3, 8], [12, 64]] as const) {
      harness.tui.terminal.rows = rows;
      const lines = harness.review.render(width);
      expect(lines).toHaveLength(rows);
      expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
      expect(lines.join('\n')).toContain(CURSOR_MARKER);
      harness.review.handleInput('\x1b[A');
      expect(harness.review.render(width).join('\n')).toContain(CURSOR_MARKER);
    }
    harness.review.focused = false;
    expect(harness.review.render(64).join('\n')).not.toContain(CURSOR_MARKER);
    harness.review.focused = true;
    expect(harness.review.render(64).join('\n')).toContain(CURSOR_MARKER);
  });

  it.each([24, 10, 6, 3])('positions the cursor in a cropped editor with %i terminal rows', (rows) => {
    const harness = createHarness(rows, 32);
    openFeedback(harness.review);
    for (let index = 0; index < 12; index += 1) {
      if (index > 0) harness.review.handleInput('\n');
      harness.review.handleInput(`Line ${index}`);
    }
    const lines = harness.review.render(32);
    const row = lines.findIndex((line) => line.includes('Line '));
    const clickedLine = /Line \d+/u.exec(lines[row]!)?.[0];
    expect(clickedLine).toBeDefined();
    const click = mouseEvent(1, row, { width: 32, height: rows });
    expect(harness.review.handleMouse({ ...click, type: 'press' })).toBeUndefined();
    expect(harness.review.handleMouse({ ...click, type: 'drag' })).toBeUndefined();
    expect(harness.review.handleMouse({ ...click, type: 'release' })).toBeUndefined();
    expect(harness.review.handleMouse(click)).toEqual({ handled: true, focus: true });
    harness.review.handleInput('!');
    harness.review.handleInput('\r');
    const expected = Array.from({ length: 12 }, (_, index) => `Line ${index}`)
      .map((line) => line === clickedLine ? `!${line}` : line).join('\n');
    expect(harness.result).toEqual({ action: 'Provide feedback', feedback: expected });
  });

  it('routes normalized wheel events to the plan and ignores clicks outside the editor', () => {
    const harness = createHarness();
    openFeedback(harness.review);
    harness.review.handleInput('Draft');
    const initial = harness.review.render(64).join('\n');
    expect(harness.review.handleMouse(mouseEvent(1, 2))).toBeUndefined();
    expect(harness.review.handleMouse(mouseEvent(0, 9))).toBeUndefined();
    expect(harness.review.handleMouse(mouseEvent(1, 2, { type: 'wheel', wheelDelta: 1 })))
      .toEqual({ handled: true });
    const scrolled = harness.review.render(64).join('\n');
    expect(scrolled).not.toEqual(initial);
    expect(scrolled).toContain('Draft');
    harness.review.handleMouse(mouseEvent(1, 2, { type: 'wheel', wheelDelta: -1 }));
    expect(harness.review.render(64).join('\n')).toEqual(initial);
    harness.review.handleInput('!');
    harness.review.handleInput('\r');
    expect(harness.result).toEqual({ action: 'Provide feedback', feedback: 'Draft!' });
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

describe('presentPlanReview', () => {
  it('settles once and removes its abort listener while feedback is open', async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const resolveReview = vi.fn();
    let review!: PlanReview;
    const ctx = {
      mode: 'tui',
      ui: {
        custom: vi.fn((factory) => new Promise<PlanReviewResult | undefined>((resolve) => {
          review = factory(
            { terminal: { rows: 24, columns: 80 }, requestRender: vi.fn() },
            theme,
            new KeybindingsManager(TUI_KEYBINDINGS),
            (result: PlanReviewResult | undefined) => { resolveReview(result); resolve(result); },
          );
        })),
      },
    } as unknown as ExtensionContext;

    const pending = presentPlanReview(ctx, '# Plan', controller.signal);
    openFeedback(review);
    review.handleInput('Unsent feedback');
    controller.abort();
    expect(await pending).toBeUndefined();
    review.handleInput('\r');
    expect(resolveReview).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});

describe('sanitizePlanForDisplay', () => {
  it('removes terminal controls while preserving Markdown and line structure', () => {
    const plan = '\u001b]52;c;secret\u0007# Heading\r\n\u0007- Keep Unicode ✓\u001b[31m\n\tcode';
    expect(sanitizePlanForDisplay(plan)).toBe('# Heading\n - Keep Unicode ✓\n\tcode');
  });
});
