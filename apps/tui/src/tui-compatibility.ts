import type { InteractiveMode } from '@earendil-works/pi-coding-agent';

const ENTER_ALT_SCREEN = '\x1b[?1049h';
const DISABLE_ALT_SCROLL = '\x1b[?1007l';
const DISABLE_MOUSE = '\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l';
const ENABLE_BUTTON_MOTION_MOUSE = '\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h';
const ENABLE_ALL_MOTION_MOUSE = '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h';

interface TerminalWriter {
  write(data: string): void;
  start?(onInput: (data: string) => void, onResize: () => void): void;
}

interface InteractiveModeTerminalInternals {
  renderer?: {
    terminal?: TerminalWriter;
    mode?: string;
  };
  showError?(message: string): void;
  switchTuiMode?(mode: string, restoreProgress?: boolean, startRenderer?: boolean): boolean;
}

const installedTerminals = new WeakSet<object>();
const installedModes = new WeakSet<object>();

export function installFelanTuiCompatibility(
  mode: InteractiveMode,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32') return;
  const internals = mode as unknown as InteractiveModeTerminalInternals;
  const terminal = internals.renderer?.terminal;
  if (!terminal || typeof terminal.write !== 'function') return;
  if (!installedTerminals.has(terminal)) {
    installedTerminals.add(terminal);
    const write = terminal.write.bind(terminal);
    terminal.write = (data: string) => write(normalizeFullscreenTerminalModes(data));
    const start = terminal.start?.bind(terminal);
    if (start) {
      terminal.start = (onInput, onResize) => {
        start(onInput, onResize);
        if (internals.renderer?.mode === 'fullscreen') {
          write(`${DISABLE_MOUSE}${DISABLE_ALT_SCROLL}${fullscreenMouseSequence()}`);
        }
      };
    }
  }

  const switchTuiMode = internals.switchTuiMode;
  if (typeof switchTuiMode !== 'function' || installedModes.has(mode)) return;
  installedModes.add(mode);
  internals.switchTuiMode = (nextMode, restoreProgress, startRenderer) => {
    if (startRenderer === false) {
      return Reflect.apply(switchTuiMode, mode, [nextMode, restoreProgress, startRenderer]);
    }
    queueMicrotask(() => {
      try {
        Reflect.apply(switchTuiMode, mode, [nextMode, restoreProgress, startRenderer]);
      } catch (error) {
        internals.showError?.(`Could not switch TUI mode: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    return true;
  };
}

export function normalizeFullscreenTerminalModes(data: string): string {
  return data.replaceAll(ENTER_ALT_SCREEN, `${DISABLE_MOUSE}${DISABLE_ALT_SCROLL}${ENTER_ALT_SCREEN}`);
}

function fullscreenMouseSequence(): string {
  const term = process.env.TERM?.toLowerCase() ?? '';
  return process.env.TMUX !== undefined
    || process.env.ZELLIJ !== undefined
    || process.env.STY !== undefined
    || term.startsWith('tmux')
    || term.startsWith('screen')
    ? ENABLE_BUTTON_MOTION_MOUSE
    : ENABLE_ALL_MOTION_MOUSE;
}
