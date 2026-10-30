import { ProcessTerminal, TuiAltScreen, setKeybindings, type KeybindingsConfig, type Terminal, type TUI } from '@earendil-works/pi-tui';
import { createSessionTitleSync } from '../client/session-title.js';
import { TuiSessionController, type TuiSessionOptions } from './controller.js';
import { DaemonTuiScreen } from './screen.js';
import { createClientKeybindings } from './keybindings.js';
import type { DaemonAction } from './commands.js';
import { TerminalInteractions } from './interactions.js';
import { createPresentationUi } from './presentation-ui.js';
import { ClientThemes } from './theme-config.js';
import type { TuiPresentationPreferences } from './preferences-schema.js';
import { TerminalPreferences } from './preferences.js';
import { createTerminalPresenters } from './presenters.js';
import { terminalToolPresentation } from './tool-presentation.js';
import { createClientPowerlineFooter, isPowerlinePresentation } from '../client/powerline-presenter.js';
import { TerminalSetup } from './setup.js';
import { createSetupUi } from './setup-ui.js';
import { themedClientTerminal } from './theme.js';
import { reportHerdrPane, type HerdrPane } from './herdr.js';
import { formatHostBlocked } from '../client/daemon-blocked.js';
import { remoteHistoryInput } from './remote.js';
import type { OpenBrowser } from './browser.js';
import { watchDaemonBuildMismatch } from '../client/build-mismatch.js';

export async function runDaemonTerminal(controller: TuiSessionController, options: TuiSessionOptions & {
  openBrowser: OpenBrowser;
  initialMessage?: string;
  theme?: string;
  presentation?: Partial<{ [K in keyof TuiPresentationPreferences]: Partial<TuiPresentationPreferences[K]> }>;
  clientConfigDir?: string;
  verbose?: boolean;
  keybindings?: KeybindingsConfig;
  terminal?: Terminal;
  createTui?: (terminal: Terminal) => TUI;
  signal?: AbortSignal;
  initialDraft?: string;
  herdr?: HerdrPane;
  onDaemonAction?(action: DaemonAction, force: boolean, draft: string, beforeAttachment?: boolean): Promise<boolean>;
}): Promise<void> {
  const themes = new ClientThemes(options.clientConfigDir, options.theme);
  const keybindings = createClientKeybindings(options.keybindings);
  setKeybindings(keybindings);
  let theme = themes.theme;
  const terminal = themedClientTerminal(options.terminal ?? new ProcessTerminal(), () => theme);
  const tui = options.createTui?.(terminal) ?? new TuiAltScreen(terminal);
  let stopped = false; let exit!: () => void; const finished = new Promise<void>(resolve => { exit = () => { stopped = true; resolve(); }; });
  let setup: TerminalSetup | undefined;
  let startupDeferred = false;
  const updateCheck = new AbortController();
  const setupAction = async (action: 'login' | 'logout' | 'dependencies', provider?: string): Promise<boolean> => {
    if (setup) {
      const completed = await (action === 'login' ? setup.login(provider) : setup[action]());
      if (completed && action === 'login' && startupDeferred && !controller.sessionId && !stopped) {
        controller.setNotice('Login completed. Use /new to create a session, then review and submit your retained input. Nothing was sent automatically.');
      }
      return completed;
    }
    controller.setNotice('Interactive setup is not ready yet. Wait for the daemon connection.');
    return false;
  };
  const preferences: TerminalPreferences = new TerminalPreferences(controller, options, async (values, bindings, next): Promise<void> => {
    if (stopped) return;
    theme = next;
    keybindings.setUserBindings(bindings);
    tui.setShowHardwareCursor(values.hardwareCursor ?? false);
    tui.setClearOnShrink(values.clearOnShrink ?? false);
    screen.editor.setPaddingX(values.editorPadding ?? 1);
    screen.editor.setAutocompleteMaxVisible(values.autocompleteMaxVisible ?? 5);
    screen.scroll.setScrollbar(values.fullscreenScrollbar ?? 'auto');
    if (tui instanceof TuiAltScreen) {
      tui.setCopyOnSelect(values.fullscreenCopyOnSelect ?? true);
      tui.setWheelScrollLines(values.fullscreenWheelScrollLines ?? 'auto');
    }
    terminal.setProgress((values.terminalProgress ?? false) && !!controller.snapshot && !['idle', 'interrupted'].includes(controller.snapshot.run.state));
    screen.refreshPresentation();
    if (themes.warnings.length) controller.setNotice(themes.warnings.join('\n'));
  }, themes);
  let builtins: ReturnType<typeof createTerminalPresenters> | undefined;
  const settings = () => preferences.settings;
  const screen: DaemonTuiScreen = new DaemonTuiScreen(controller, tui, { cwd: options.cwd, openBrowser: options.openBrowser, exit, settings, theme: () => theme, quietStartup: () => preferences.values.quietStartup ?? false, preferences: (): Promise<boolean> => preferences.open(screen.dialogs),
    agents: async id => { if (!builtins) throw new Error('Session UI is not ready.'); await builtins.openExecutions(id); },
    login: (provider?: string): Promise<boolean> => setupAction('login', provider), logout: (): Promise<boolean> => setupAction('logout'), dependencies: (): Promise<boolean> => setupAction('dependencies'), toolPresentation: terminalToolPresentation,
    hasRenderer: element => isPowerlinePresentation(element) || ('hint' in element && !!builtins?.presenters.hints.get(element.hint)),
    ui: async () => {
      if (!interactions) throw new Error('Session UI is not ready.');
      const elements = interactions.elements().filter(element => !isPowerlinePresentation(element));
      if (!elements.length) { controller.setNotice('No session UI surfaces are available.'); return false; }
      const selected = await screen.dialogs.select('Session UI', elements.map(element => ({ value: element.id,
        label: element.kind === 'progress' ? element.label : element.kind === 'status' ? element.key : element.title, description: element.fallback })));
      if (selected === undefined) return false;
      interactions.showElement(selected); return true;
    },
    ...(options.onDaemonAction ? { daemon: async (action: DaemonAction, force: boolean): Promise<void> => {
      if (await options.onDaemonAction!(action, force, screen.editor.getExpandedText())) exit();
    } } : {}),
  });
  if (options.initialDraft) screen.editor.setText(options.initialDraft);
  let interactions: TerminalInteractions | undefined;
  let footer: ReturnType<typeof createClientPowerlineFooter> | undefined;
  let unsubscribeFooter: (() => void) | undefined;
  let unsubscribeTitle: (() => void) | undefined;
  let unsubscribeSetup: (() => void) | undefined;
  let unsubscribeColors: (() => void) | undefined;
  let unsubscribeHerdr: (() => void) | undefined;
  const unsubscribeBuildMismatch = watchDaemonBuildMismatch(controller.client,
    'Run /restart to apply the new build.', message => controller.announce(message, 'warning'));
  const interrupt = () => exit();
  options.signal?.addEventListener('abort', interrupt, { once: true });
  process.once('SIGTERM', interrupt); process.once('SIGHUP', interrupt); process.once('SIGINT', interrupt);
  if ('setLayoutRoot' in tui && typeof tui.setLayoutRoot === 'function') tui.setLayoutRoot(screen.component);
  else tui.addChild(screen.component);
  screen.focus();
  try {
    tui.start();
    if (options.signal?.aborted) return;
    const loadingPreferences = preferences.load();
    if (typeof tui.onTerminalColorSchemeChange === 'function') {
      unsubscribeColors = tui.onTerminalColorSchemeChange(value => { themes.setAppearance(value); theme = themes.theme; screen.refreshPresentation(); });
      tui.setTerminalColorSchemeNotifications(true);
    }
    const applyTerminalColors = (colors: Awaited<ReturnType<TUI['queryTerminalColors']>>) => {
      if (stopped) return;
      themes.setTerminalColors(colors); theme = themes.theme; screen.refreshPresentation();
    };
    void tui.queryTerminalColors({ timeoutMs: 1000, onLateReply: applyTerminalColors }).then(applyTerminalColors).catch(() => {});
    setup = new TerminalSetup(controller, createSetupUi(tui, screen.dialogs, () => theme, keybindings, () => !interactions?.busy), options.openBrowser);
    let setupSession: string | undefined;
    unsubscribeSetup = controller.subscribe(() => {
      if (!controller.sessionId || controller.state?.status !== 'live' || setupSession === controller.sessionId) return;
      setupSession = controller.sessionId;
      if (!stopped && !setup!.busy && !tui.hasOverlay()) void setup!.dependencies(true);
    });
    const ui = createPresentationUi(tui, screen.dialogs, () => theme, keybindings, message => controller.setNotice(message));
    builtins = createTerminalPresenters(controller, ui, { settings, presentationPreferences: () => preferences.presentation, toolPresentation: terminalToolPresentation,
      executionsChanged: executions => screen.setExecutions(executions),
      setEditorText: text => { screen.editor.setText(text); tui.requestRender(); } });
    let footerSession: string | undefined;
    const syncTitle = createSessionTitleSync(terminal, options.cwd);
    unsubscribeTitle = controller.subscribe(() => syncTitle(controller.snapshot));
    syncTitle(controller.snapshot);
    unsubscribeFooter = controller.subscribe(() => {
      terminal.setProgress((preferences.values.terminalProgress ?? false) && !!controller.snapshot && !['idle', 'interrupted'].includes(controller.snapshot.run.state));
      if (footerSession === controller.sessionId) return;
      footerSession = controller.sessionId; footer?.dispose(); footer = undefined;
      if (footerSession) footer = createClientPowerlineFooter(controller.client, footerSession, {
        theme: () => theme, preferences: () => preferences.presentation.powerline, requestRender: () => tui.requestRender(), onError: message => controller.setNotice(message),
      });
      screen.setFooter(footer);
    });
    interactions = new TerminalInteractions(controller, builtins.presenters, {
      get busy() { return setup!.busy || screen.dialogs.secretInputActive; },
      subscribe(listener) {
        const unsubscribeSetup = setup!.subscribe(listener); const unsubscribeDialogs = screen.dialogs.subscribe(listener);
        return () => { unsubscribeSetup(); unsubscribeDialogs(); };
      },
    });
    const prompts = interactions;
    if (options.herdr) unsubscribeHerdr = reportHerdrPane(controller, options.herdr, () => prompts.pending());
    const starting = controller.start(options, async listing => {
      const { pickSession } = await import('./session-navigator.js');
      return (await pickSession(screen.dialogs, listing, options.cwd, undefined, () => theme, false))?.session;
    }, async () => {
      await loadingPreferences;
      if (stopped) return false;
      if (!controller.client.capabilities?.operations.includes('host.status')) return;
      const response = await controller.perform('host.status', {});
      if (response.outcome !== 'accepted') throw new Error(controller.notice);
      for (const need of response.result.setupNeeds) if (need.code === 'remote') controller.announce(need.message, 'warning');
      const blocked = response.result.state === 'blocked';
      if (!blocked && !response.result.setupNeeds.some(need => need.code === 'provider')) return;
      startupDeferred = true;
      const draft = screen.editor.getExpandedText();
      if (draft) screen.editor.addToHistory(remoteHistoryInput(draft));
      if (options.initialMessage && options.initialMessage !== draft) screen.editor.addToHistory(remoteHistoryInput(options.initialMessage));
      if (!draft && options.initialMessage) screen.editor.setText(options.initialMessage);
      controller.setNotice(blocked ? formatHostBlocked(response.result.blocked, { client: 'tui' })
        : 'No model is available. Use /login, then /new. Your input is retained in the editor/history and was not sent.', blocked);
      return false;
    }).then(async () => {
      if (stopped) return;
      void import('../update.js').then(({ checkForFelanUpdate }) => checkForFelanUpdate({ signal: updateCheck.signal })).then(version => {
        if (version && !stopped) controller.announce(`Felan ${version} is available. Run felan update to upgrade.`);
      }).catch(() => {});
      if (startupDeferred) return;
      if (options.verbose) controller.setNotice(`Daemon ${controller.client.capabilities?.daemonVersion ?? 'unavailable'} · ${controller.sessionId ?? 'no session'}`);
      if (options.resume && !controller.sessionId) exit();
      else if (options.initialMessage) await screen.submit(options.initialMessage);
    }).catch(async error => {
      if (controller.client.status !== 'incompatible' || !options.onDaemonAction) throw error;
      const work = controller.client.incompatibleActiveWork;
      const interrupted = work === undefined ? 'Active work may be interrupted.' : `${work} active task${work === 1 ? '' : 's'} will be interrupted.`;
      if (await screen.dialogs.confirm('Restart daemon', `The running daemon has an incompatible protocol or provider configuration. Restart it now? ${interrupted}`)) {
        if (await options.onDaemonAction('restart', true, screen.editor.getExpandedText(), true)) exit();
      } else exit();
    });
    await Promise.race([starting.then(() => finished), finished]);
  } finally {
    updateCheck.abort();
    unsubscribeBuildMismatch();
    stopped = true; preferences.dispose();
    options.signal?.removeEventListener('abort', interrupt); process.removeListener('SIGTERM', interrupt); process.removeListener('SIGHUP', interrupt); process.removeListener('SIGINT', interrupt);
    unsubscribeColors?.(); unsubscribeSetup?.(); unsubscribeFooter?.(); unsubscribeTitle?.(); unsubscribeHerdr?.(); footer?.dispose();
    const stopInteractions = interactions?.dispose();
    void stopInteractions?.catch(() => {});
    await setup?.dispose();
    const cleanup = await Promise.allSettled([stopInteractions, builtins?.dispose(), controller.dispose(), screen.dispose()]);
    terminal.setProgress(false);
    tui.stop();
    const failures = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Terminal cleanup failed.');
  }
}
