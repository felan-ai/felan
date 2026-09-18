import { getSelectListTheme, type InteractiveMode } from '@earendil-works/pi-coding-agent';
import { formatSessionTerminalTitle } from '@felan-ai/ext-session-title';
import { installOverlayImageStacking } from './overlay-images.js';

const ENTER_ALT_SCREEN = '\x1b[?1049h';
const DISABLE_ALT_SCROLL = '\x1b[?1007l';
const DISABLE_MOUSE = '\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l';
const ENABLE_BUTTON_MOTION_MOUSE = '\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h';
const ENABLE_ALL_MOTION_MOUSE = '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h';

interface TerminalWriter {
  write(data: string): void;
  start?(onInput: (data: string) => void, onResize: () => void): void;
}

interface TerminalTitleWriter {
  setTitle(title: string): void;
}

interface TerminalTitleSessionManager {
  getCwd(): string;
  getSessionName(): string | undefined;
}

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

interface InteractiveModeTerminalInternals {
  ui?: {
    terminal?: TerminalTitleWriter;
    queryTerminalColorScheme?(options: { timeoutMs: number }): Promise<'light' | 'dark' | undefined>;
    queryTerminalBackgroundColor?(options: { timeoutMs: number }): Promise<RgbColor | undefined>;
  };
  sessionManager?: TerminalTitleSessionManager;
  renderer?: {
    terminal?: TerminalWriter;
    mode?: string;
  };
  setWorkingIndicator?(options?: WorkingIndicatorOptions): void;
  showError?(message: string): void;
  showStatus?(message: string): void;
  switchTuiMode?(mode: string, restoreProgress?: boolean, startRenderer?: boolean): boolean;
  updateTerminalTitle?(): void;
  themeController?: {
    onChanged?: () => void;
    applyTerminalTheme?(theme: 'light' | 'dark'): void;
  };
}

interface WorkingIndicatorOptions {
  frames?: string[];
  intervalMs?: number;
}

const FELAN_WORKING_FRAMES = ['⠐◉ ', '⠈◉ ', ' ◉⠁', ' ◉⠂', ' ◉⠄', '⠠◉ '];
const FELAN_WORKING_INTERVAL_MS = 120;
const installedTerminals = new WeakSet<object>();
const installedModes = new WeakSet<object>();
const installedMessageFilters = new WeakSet<object>();
const installedTerminalTitles = new WeakSet<object>();
const installedWorkingIndicators = new WeakSet<object>();
const installedThemeDetection = new WeakSet<object>();

export function installFelanTuiCompatibility(
  mode: InteractiveMode,
  platform: NodeJS.Platform = process.platform,
): void {
  const internals = mode as unknown as InteractiveModeTerminalInternals;
  installOverlayImageStacking();
  installPiMessageFilters(mode, internals);
  installFelanTerminalTitle(mode, internals);
  installFelanWorkingIndicator(mode, internals);
  installFelanTerminalThemeDetection(internals);
  if (platform !== 'win32') return;
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

function installFelanTerminalTitle(
  mode: InteractiveMode,
  internals: InteractiveModeTerminalInternals,
): void {
  const updateTerminalTitle = internals.updateTerminalTitle;
  if (typeof updateTerminalTitle !== 'function' || installedTerminalTitles.has(mode)) return;
  installedTerminalTitles.add(mode);

  internals.updateTerminalTitle = () => {
    const terminal = internals.ui?.terminal;
    const sessionManager = internals.sessionManager;
    if (!terminal || !sessionManager) {
      Reflect.apply(updateTerminalTitle, mode, []);
      return;
    }
    terminal.setTitle(formatSessionTerminalTitle(
      sessionManager.getSessionName(),
      sessionManager.getCwd(),
    ));
  };
}

function installFelanTerminalThemeDetection(
  internals: InteractiveModeTerminalInternals,
): void {
  const ui = internals.ui;
  const themeController = internals.themeController;
  if (!ui || installedThemeDetection.has(ui)) return;
  installedThemeDetection.add(ui);

  // Pi auto-theme prefers CSI 997 OS color-scheme over OSC 11 terminal background.
  ui.queryTerminalColorScheme = async () => undefined;

  const applyTerminalTheme = themeController?.applyTerminalTheme;
  if (!themeController || typeof applyTerminalTheme !== 'function') return;
  themeController.applyTerminalTheme = (terminalTheme) => {
    const query = ui.queryTerminalBackgroundColor;
    if (typeof query !== 'function') {
      Reflect.apply(applyTerminalTheme, themeController, [terminalTheme]);
      return;
    }
    void query({ timeoutMs: 100 }).then((rgb) => {
      Reflect.apply(applyTerminalTheme, themeController, [rgb ? themeForRgb(rgb) : terminalTheme]);
    }).catch(() => {
      Reflect.apply(applyTerminalTheme, themeController, [terminalTheme]);
    });
  };
}

function themeForRgb(rgb: RgbColor): 'light' | 'dark' {
  const toLinear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
  return luminance >= 0.5 ? 'light' : 'dark';
}

function installFelanWorkingIndicator(
  mode: InteractiveMode,
  internals: InteractiveModeTerminalInternals,
): void {
  if (installedWorkingIndicators.has(mode)) return;
  const setWorkingIndicator = internals.setWorkingIndicator;
  if (typeof setWorkingIndicator !== 'function') return;
  installedWorkingIndicators.add(mode);

  let usesFelanIndicator = true;
  internals.setWorkingIndicator = (options) => {
    usesFelanIndicator = options === undefined;
    Reflect.apply(setWorkingIndicator, mode, [options ?? createFelanWorkingIndicator()]);
  };

  // Pi renders custom frames verbatim, so rebuild their ANSI colors when the active theme changes.
  const themeController = internals.themeController;
  const onThemeChanged = themeController?.onChanged;
  if (themeController && typeof onThemeChanged === 'function') {
    themeController.onChanged = () => {
      Reflect.apply(onThemeChanged, themeController, []);
      if (usesFelanIndicator) internals.setWorkingIndicator?.();
    };
  }
  internals.setWorkingIndicator();
}

function createFelanWorkingIndicator(): WorkingIndicatorOptions {
  const accent = getSelectListTheme().selectedPrefix;
  return {
    frames: FELAN_WORKING_FRAMES.map((frame) => accent(frame)),
    intervalMs: FELAN_WORKING_INTERVAL_MS,
  };
}

function installPiMessageFilters(
  mode: InteractiveMode,
  internals: InteractiveModeTerminalInternals,
): void {
  if (installedMessageFilters.has(mode)) return;
  installedMessageFilters.add(mode);

  const showStatus = internals.showStatus;
  if (typeof showStatus === 'function') {
    internals.showStatus = (message) => {
      if (message === 'Auto-compaction cancelled') return;
      Reflect.apply(showStatus, mode, [message]);
    };
  }

  const showError = internals.showError;
  if (typeof showError === 'function') {
    internals.showError = (message) => {
      if (message.startsWith('Compaction failed:')
        && /(?:operation was aborted|compaction cancelled)$/iu.test(message)) return;
      Reflect.apply(showError, mode, [message]);
    };
  }
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
