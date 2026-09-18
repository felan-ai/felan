import {
  TuiAltScreen,
  TuiMainScreen,
  compositeTuiLine,
  setCapabilities,
  resetCapabilitiesCache,
  visibleWidth,
  type Component,
  type Terminal,
} from '@earendil-works/pi-tui';
import { afterEach, describe, expect, it } from 'vitest';
import { installFelanTuiCompatibility } from '../src/tui-compatibility.js';
import {
  compositeOverlayLine,
  installOverlayImageStacking,
  isTerminalImageLine,
  suppressImagesIntersectingOverlays,
} from '../src/overlay-images.js';

const KITTY_PAYLOAD = 'QUFBQQ==';
const KITTY_IMAGE = kittyImageLine(5);
const ITERM2_IMAGE = '\x1b]1337;File=inline=1;width=10:QUFBQQ==\x07';
const OVERLAY_TEXT = 'PLAN';
const KITTY_DELETE = /\x1b_Ga=d,d=[aA],q=2/;

afterEach(() => {
  resetCapabilitiesCache();
});

describe('overlay image stacking helper', () => {
  it('detects Kitty and iTerm2 protocol lines', () => {
    expect(isTerminalImageLine(KITTY_IMAGE)).toBe(true);
    expect(isTerminalImageLine(`up${KITTY_IMAGE}`)).toBe(true);
    expect(isTerminalImageLine(ITERM2_IMAGE)).toBe(true);
    expect(isTerminalImageLine('PLAN')).toBe(false);
  });

  it('replaces image protocol lines with overlay text instead of keeping the sequence', () => {
    const overlay = overlayLine(OVERLAY_TEXT, 20);
    const fromKitty = compositeOverlayLine(KITTY_IMAGE, overlay, 0, 20, 20);
    const fromITerm = compositeOverlayLine(ITERM2_IMAGE, overlay, 0, 20, 20);

    expect(fromKitty).toContain(OVERLAY_TEXT);
    expect(fromKitty).not.toContain('\x1b_G');
    expect(fromITerm).toContain(OVERLAY_TEXT);
    expect(fromITerm).not.toContain('\x1b]1337;File=');
    expect(compositeTuiLine(KITTY_IMAGE, overlay, 0, 20, 20)).toBe(KITTY_IMAGE);
  });

  it('composites overlay text onto ordinary lines', () => {
    const overlay = overlayLine(OVERLAY_TEXT, 8);
    const result = compositeOverlayLine('background text here', overlay, 0, 8, 20);
    expect(result).toContain(OVERLAY_TEXT);
    expect(isTerminalImageLine(result)).toBe(false);
  });

  it('blanks a Kitty image whose reserved rows tail-overlap an overlay', () => {
    const lines = [KITTY_IMAGE, '', '', '', '', 'after'];
    const result = suppressImagesIntersectingOverlays(lines, [{ row: 3, height: 2 }], 6);
    expect(result[0]).toBe('');
    expect(result[5]).toBe('after');
  });

  it('leaves images that do not intersect the overlay unchanged', () => {
    const lines = [KITTY_IMAGE, '', '', '', '', 'after'];
    const result = suppressImagesIntersectingOverlays(lines, [{ row: 5, height: 1 }], 6);
    expect(result).toEqual(lines);
  });

  it('measures reserved rows from the pre-overlay image source', () => {
    const source = [KITTY_IMAGE, '', '', '', '', 'after'];
    const composited = [KITTY_IMAGE, '', '', OVERLAY_TEXT, OVERLAY_TEXT, 'after'];
    const result = suppressImagesIntersectingOverlays(
      composited,
      [{ row: 3, height: 2 }],
      6,
      source,
    );
    expect(result[0]).toBe('');
    expect(result[3]).toBe(OVERLAY_TEXT);
    expect(result[5]).toBe('after');
  });
});

describe('overlay image stacking install', () => {
  it('patches both TUI hosts and is idempotent', () => {
    installOverlayImageStacking();
    installOverlayImageStacking();
    expect(typeof overlayCompositor(TuiAltScreen).compositeLineAt).toBe('function');
    expect(typeof overlayCompositor(TuiMainScreen).compositeLineAt).toBe('function');
    expect(overlayCompositor(TuiAltScreen)).toBe(overlayCompositor(TuiMainScreen));
  });

  it('installs from TUI compatibility on non-Windows hosts', () => {
    installFelanTuiCompatibility({} as never, 'darwin');
    expect(typeof overlayCompositor(TuiAltScreen).compositeLineAt).toBe('function');
  });
});

describe('overlay image stacking TUI render', () => {
  it('keeps a fullscreen overlay above a multi-row Kitty image', () => {
    const { tui, terminal, overlay } = createImageOverlayHarness();
    tui.addChild(new ImageStub(5));
    tui.start();
    try {
      tui.renderNow(true);
      expect(terminal.output).toContain(KITTY_PAYLOAD);

      terminal.writes.length = 0;
      tui.showOverlay(overlay, {
        anchor: 'top-left',
        width: '100%',
        maxHeight: '100%',
        margin: 0,
      });
      tui.renderNow(true);

      expect(terminal.output).toMatch(KITTY_DELETE);
      expect(terminal.output).toContain('PLAN REVIEW');
      expect(terminal.output).not.toContain(KITTY_PAYLOAD);
    } finally {
      tui.stop();
    }
  });

  it('clears a Kitty image whose reserved rows intersect a smaller overlay', () => {
    const { tui, terminal, overlay } = createImageOverlayHarness();
    tui.addChild(new ImageStub(8));
    tui.start();
    try {
      tui.renderNow(true);
      expect(terminal.output).toContain(KITTY_PAYLOAD);

      terminal.writes.length = 0;
      tui.showOverlay(overlay, {
        anchor: 'top-left',
        row: 5,
        width: '100%',
        maxHeight: 3,
        margin: 0,
      });
      tui.renderNow(true);

      expect(terminal.output).toMatch(KITTY_DELETE);
      expect(terminal.output).toContain('PLAN REVIEW');
      expect(terminal.output).not.toContain(KITTY_PAYLOAD);
    } finally {
      tui.stop();
    }
  });
});

function createImageOverlayHarness() {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
  installOverlayImageStacking();
  const terminal = new RecordingTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const overlay = new OverlayStub();
  return { tui, terminal, overlay };
}

function kittyImageLine(rows: number): string {
  return `\x1b_Ga=T,f=100,q=2,C=1,c=10,r=${rows},i=42;${KITTY_PAYLOAD}\x1b\\`;
}

class ImageStub implements Component {
  constructor(private readonly rows: number) {}

  render(): string[] {
    return [kittyImageLine(this.rows), ...Array.from({ length: this.rows - 1 }, () => ''), 'after image'];
  }
}

class OverlayStub implements Component {
  render(width: number): string[] {
    return Array.from({ length: 12 }, () => overlayLine('PLAN REVIEW', width));
  }
}

class RecordingTerminal implements Terminal {
  readonly columns = 40;
  readonly rows = 12;
  readonly kittyProtocolActive = false;
  readonly writes: string[] = [];
  #onInput?: (data: string) => void;

  get output(): string {
    return this.writes.join('');
  }

  start(onInput: (data: string) => void): void {
    this.#onInput = onInput;
  }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data);
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  send(data: string): void {
    this.#onInput?.(data);
  }
}

function overlayLine(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleWidth(text)));
}

function overlayCompositor(ctor: { prototype: object }): { compositeLineAt?: unknown } {
  return Object.getPrototypeOf(ctor.prototype) as { compositeLineAt?: unknown };
}
