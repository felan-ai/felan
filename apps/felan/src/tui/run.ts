import { ProcessTerminal, TuiAltScreen, setKeybindings, type KeybindingsConfig, type Terminal, type TUI } from '@earendil-works/pi-tui';
import { TuiSessionController, type TuiSessionOptions } from './controller.js';
import { DaemonTuiScreen } from './screen.js';
import { createClientKeybindings } from './keybindings.js';
import type { DaemonAction } from './commands.js';
import { TerminalInteractions } from './interactions.js';
import { createPresentationUi } from './presentation-ui.js';
import { ClientThemes } from './theme-config.js';
import { TerminalPreferences } from './preferences.js';
import { createTerminalPresenters } from './presenters.js';
import { terminalToolPresentation } from './tool-presentation.js';
import { createClientPowerlineFooter, isPowerlinePresentation } from '../client/powerline-presenter.js';
import { TerminalSetup } from './setup.js';
import { createSetupUi } from './setup-ui.js';
import { themedClientTerminal } from './theme.js';
import { checkForFelanUpdate } from '../update.js';

export async function runDaemonTerminal(controller: TuiSessionController, options: TuiSessionOptions & {
  initialMessage?: string;
  theme?: string;
  clientConfigDir?: string;
  verbose?: boolean;
  keybindings?: KeybindingsConfig;
  terminal?: Terminal;
  createTui?: (terminal: Terminal) => TUI;
  signal?: AbortSignal;
  initialDraft?: string;
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
  const preferences: TerminalPreferences = new TerminalPreferences(controller, options, async (_values, bindings, next): Promise<void> => {
    if (stopped) return;
    theme = next;
    keybindings.setUserBindings(bindings);
    screen.refreshPresentation();
    if (themes.warnings.length) controller.setNotice(themes.warnings.join('\n'));
  }, themes);
  let builtins: ReturnType<typeof createTerminalPresenters> | undefined;
  const settings = () => preferences.settings;
  const screen: DaemonTuiScreen = new DaemonTuiScreen(controller, tui, { cwd: options.cwd, exit, settings, theme: () => theme, preferences: (): Promise<boolean> => preferences.open(screen.dialogs),
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
  let unsubscribeSetup: (() => void) | undefined;
  let unsubscribeColors: (() => void) | undefined;
  const interrupt = () => exit();
  options.signal?.addEventListener('abort', interrupt, { once: true });
  process.once('SIGTERM', interrupt); process.once('SIGHUP', interrupt); process.once('SIGINT', interrupt);
  if ('setLayoutRoot' in tui && typeof tui.setLayoutRoot === 'function') tui.setLayoutRoot(screen.component);
  else tui.addChild(screen.component);
  screen.focus();
  try {
    tui.start();
    if (options.signal?.aborted) return;
    if (typeof tui.onTerminalColorSchemeChange === 'function') {
      unsubscribeColors = tui.onTerminalColorSchemeChange(value => { themes.setAppearance(value); theme = themes.theme; screen.refreshPresentation(); });
      tui.setTerminalColorSchemeNotifications(true);
    }
    setup = new TerminalSetup(controller, createSetupUi(tui, screen.dialogs, () => theme, keybindings, () => !interactions?.busy));
    let setupSession: string | undefined;
    unsubscribeSetup = controller.subscribe(() => {
      if (!controller.sessionId || controller.state?.status !== 'live' || setupSession === controller.sessionId) return;
      setupSession = controller.sessionId;
      if (!stopped && !setup!.busy && !tui.hasOverlay()) void setup!.dependencies(true);
    });
    const ui = createPresentationUi(tui, screen.dialogs, () => theme, keybindings, message => controller.setNotice(message));
    builtins = createTerminalPresenters(controller, ui, { settings, toolPresentation: terminalToolPresentation,
      executionsChanged: executions => screen.setExecutions(executions),
      setEditorText: text => { screen.editor.setText(text); tui.requestRender(); } });
    let footerSession: string | undefined;
    unsubscribeFooter = controller.subscribe(() => {
      if (footerSession === controller.sessionId) return;
      footerSession = controller.sessionId; footer?.dispose(); footer = undefined;
      if (footerSession) footer = createClientPowerlineFooter(controller.client, footerSession, {
        theme: () => theme, requestRender: () => tui.requestRender(), onError: message => controller.setNotice(message),
      });
      screen.setFooter(footer);
    });
    interactions = new TerminalInteractions(controller, builtins.presenters, setup);
    const starting = controller.start(options, sessions => screen.dialogs.select('Resume session', sessions.map(session => ({ value: session.session,
      label: session.title || session.session, description: `${session.cwd} · ${session.run.state}` }))), async () => {
      await preferences.load();
      if (!controller.client.capabilities?.operations.includes('host.status')) return;
      const response = await controller.perform('host.status', {});
      if (response.outcome !== 'accepted') throw new Error(controller.notice);
      if (!response.result.setupNeeds.some(need => need.code === 'provider')) return;
      startupDeferred = true;
      const draft = screen.editor.getExpandedText();
      if (draft) screen.editor.addToHistory(draft);
      if (options.initialMessage && options.initialMessage !== draft) screen.editor.addToHistory(options.initialMessage);
      if (!draft && options.initialMessage) screen.editor.setText(options.initialMessage);
      controller.setNotice('No model is available. Use /login, then /new. Your input is retained in the editor/history and was not sent.');
      return false;
    }).then(async () => {
      if (stopped) return;
      void checkForFelanUpdate({ signal: updateCheck.signal }).then(version => {
        if (version && !stopped) controller.setNotice([controller.notice, `Felan ${version} is available. Run felan update to upgrade.`].filter(Boolean).join('\n'));
      });
      if (startupDeferred) return;
      if (options.verbose) controller.setNotice(`Daemon ${controller.client.capabilities?.daemonVersion ?? 'unavailable'} · ${controller.sessionId ?? 'no session'}`);
      if (options.resume && !controller.sessionId) exit();
      else if (options.initialMessage) await screen.submit(options.initialMessage);
    }).catch(async error => {
      if (error?.code === 'configuration_recovery_required' && typeof error.sessionId === 'string') {
        if (await screen.dialogs.confirm('Reload session configuration', 'Use the current configuration for this saved session? Its transcript and identity are retained.')) {
          if (await controller.reloadSession(error.sessionId) && options.initialMessage) await screen.submit(options.initialMessage);
        } else controller.setNotice(`Session was not changed. Use /reload ${error.sessionId} to recover it explicitly.`);
        return;
      }
      if (controller.client.status !== 'incompatible' || !options.onDaemonAction) throw error;
      if (await screen.dialogs.confirm('Daemon version mismatch', 'Restart the verified daemon with the installed version? Active work will be drained, not forced.')) {
        if (await options.onDaemonAction('restart', false, screen.editor.getExpandedText(), true)) exit();
      } else exit();
    });
    await Promise.race([starting.then(() => finished), finished]);
  } finally {
    updateCheck.abort();
    stopped = true; preferences.dispose();
    options.signal?.removeEventListener('abort', interrupt); process.removeListener('SIGTERM', interrupt); process.removeListener('SIGHUP', interrupt); process.removeListener('SIGINT', interrupt);
    unsubscribeColors?.(); unsubscribeSetup?.(); unsubscribeFooter?.(); footer?.dispose();
    const stopInteractions = interactions?.dispose();
    void stopInteractions?.catch(() => {});
    await setup?.dispose();
    const cleanup = await Promise.allSettled([stopInteractions, builtins?.dispose(), controller.dispose(), screen.dispose()]);
    tui.stop();
    const failures = cleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Terminal cleanup failed.');
  }
}
