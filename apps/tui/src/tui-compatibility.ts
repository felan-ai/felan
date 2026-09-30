import {
  getMarkdownTheme,
  getSelectListTheme,
  type InteractiveMode,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { Spacer } from '@earendil-works/pi-tui';
import {
  CompactionMethodMessageComponent,
  compactionMethodForMessage,
} from './compaction-presentation.js';
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
  buildContextEntries?(): readonly SessionEntry[];
}

interface InteractiveModeTerminalInternals {
  ui?: {
    terminal?: TerminalTitleWriter;
    requestRender?(): void;
  };
  sessionManager?: TerminalTitleSessionManager;
  renderer?: {
    terminal?: TerminalWriter;
    mode?: string;
  };
  getUserInput?(): Promise<string>;
  handleEvent?(event: InteractiveModeEvent): Promise<void> | void;
  showWorkingStatusIndicator?(): void;
  clearStatusIndicator?(expectedKind?: string): void;
  setWorkingIndicator?(options?: WorkingIndicatorOptions): void;
  showError?(message: string): void;
  showStatus?(message: string): void;
  addMessageToChat?(message: unknown, options?: unknown): void;
  switchTuiMode?(mode: string, restoreProgress?: boolean, startRenderer?: boolean): boolean;
  updateTerminalTitle?(): void;
  themeController?: {
    onChanged?: () => void;
  };
}

interface WorkingIndicatorOptions {
  frames?: string[];
  intervalMs?: number;
}

interface InteractiveModeEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

const FELAN_WORKING_FRAMES = ['⠐◉ ', '⠈◉ ', ' ◉⠁', ' ◉⠂', ' ◉⠄', '⠠◉ '];
const FELAN_WORKING_INTERVAL_MS = 120;
const installedTerminals = new WeakSet<object>();
const installedModes = new WeakSet<object>();
const installedMessageFilters = new WeakSet<object>();
const installedTerminalTitles = new WeakSet<object>();
const installedWorkingIndicators = new WeakSet<object>();
const installedPromptPreflightStatus = new WeakSet<object>();
const installedCompactionPresenters = new WeakSet<object>();

export function installFelanTuiCompatibility(
  mode: InteractiveMode,
  platform: NodeJS.Platform = process.platform,
): void {
  const internals = mode as unknown as InteractiveModeTerminalInternals;
  installOverlayImageStacking();
  installPiMessageFilters(mode, internals);
  installCompactionPresenter(mode, internals);
  installFelanTerminalTitle(mode, internals);
  installFelanWorkingIndicator(mode, internals);
  installPromptPreflightWorkingStatus(mode, internals);
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

function installCompactionPresenter(
  mode: InteractiveMode,
  internals: InteractiveModeTerminalInternals,
): void {
  if (installedCompactionPresenters.has(mode)) return;
  const addMessageToChat = internals.addMessageToChat;
  const sessionManager = internals.sessionManager;
  const buildContextEntries = sessionManager?.buildContextEntries;
  if (typeof addMessageToChat !== 'function' || typeof buildContextEntries !== 'function') return;
  installedCompactionPresenters.add(mode);

  internals.addMessageToChat = (message, options) => {
    if (!isCompactionSummaryMessage(message)) {
      Reflect.apply(addMessageToChat, mode, [message, options]);
      return;
    }
    const method = compactionMethodForMessage(Reflect.apply(buildContextEntries, sessionManager, []), message);
    if (method === undefined) {
      Reflect.apply(addMessageToChat, mode, [message, options]);
      return;
    }
    const chatContainer = (mode as unknown as { chatContainer?: { addChild(child: unknown): void } }).chatContainer;
    if (!chatContainer) {
      Reflect.apply(addMessageToChat, mode, [message, options]);
      return;
    }
    chatContainer.addChild(new Spacer(1));
    const component = new CompactionMethodMessageComponent(message, method, getMarkdownTheme());
    const expanded = (mode as unknown as { toolOutputExpanded?: unknown }).toolOutputExpanded;
    if (typeof expanded === 'boolean') component.setExpanded(expanded);
    chatContainer.addChild(component);
  };
}

interface CompactionSummaryMessageLike {
  readonly role: 'compactionSummary';
  readonly summary: string;
  readonly tokensBefore: number;
  readonly timestamp: number;
}

function isCompactionSummaryMessage(value: unknown): value is CompactionSummaryMessageLike {
  return isRecord(value)
    && value.role === 'compactionSummary'
    && typeof value.summary === 'string'
    && typeof value.tokensBefore === 'number'
    && typeof value.timestamp === 'number';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function installPromptPreflightWorkingStatus(
  mode: InteractiveMode,
  internals: InteractiveModeTerminalInternals,
): void {
  if (installedPromptPreflightStatus.has(mode)) return;
  const getUserInput = internals.getUserInput;
  const handleEvent = internals.handleEvent;
  const showWorkingStatusIndicator = internals.showWorkingStatusIndicator;
  const clearStatusIndicator = internals.clearStatusIndicator;
  if (
    typeof getUserInput !== 'function'
    || typeof handleEvent !== 'function'
    || typeof showWorkingStatusIndicator !== 'function'
    || typeof clearStatusIndicator !== 'function'
  ) return;
  installedPromptPreflightStatus.add(mode);

  // Pi starts its normal working state only after before_agent_start completes.
  let awaitingTurn = false;
  const clearPreflightStatus = () => {
    if (!awaitingTurn) return;
    awaitingTurn = false;
    try {
      Reflect.apply(clearStatusIndicator, mode, ['working']);
      internals.ui?.requestRender?.();
    } catch {
      // Presentation compatibility must not block prompt handling.
    }
  };

  internals.getUserInput = async () => {
    clearPreflightStatus();
    const input = await Reflect.apply(getUserInput, mode, []);
    if (input.startsWith('/')) return input;
    awaitingTurn = true;
    try {
      Reflect.apply(showWorkingStatusIndicator, mode, []);
      internals.ui?.requestRender?.();
    } catch {
      clearPreflightStatus();
    }
    return input;
  };

  internals.handleEvent = async (event) => {
    if (event.type === 'turn_start') awaitingTurn = false;
    await Reflect.apply(handleEvent, mode, [event]);
  };

  const showError = internals.showError;
  if (typeof showError === 'function') {
    internals.showError = (message) => {
      clearPreflightStatus();
      Reflect.apply(showError, mode, [message]);
    };
  }
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
