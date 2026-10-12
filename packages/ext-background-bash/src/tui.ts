import { Text } from '@earendil-works/pi-tui';
import type { BackgroundBashPresentationHost } from './presentation.js';
import { BackgroundBashView } from './ui/background-bash-view.js';
import { registerBackgroundBashCompletionRenderer } from './ui/completion-message.js';

export function createTuiBackgroundBashHost(): BackgroundBashPresentationHost {
  return {
    install: registerBackgroundBashCompletionRenderer,
    renderCall(args, theme) {
      const value = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {};
      const command = typeof value.command === 'string' ? value.command : '';
      const suffix = value.tty === true ? ' (pty)' : value.background === true ? ' (background)' : '';
      return new Text(theme.fg('toolTitle', theme.bold(`$ ${command}`)) + theme.fg('muted', suffix), 0, 0);
    },
    status(ui, running) {
      if (running === undefined || running === 0) { ui.setStatus('background-bash', undefined); return; }
      const text = running === 'unavailable' ? ui.theme.fg('warning', 'bash ?')
        : `${ui.theme.fg('accent', '●')} ${ui.theme.fg('accent', running === 1 ? '1 process' : `${running} processes`)}`;
      ui.setStatus('background-bash', text);
    },
    async show(ui, source, signal) {
      if (signal.aborted) return;
      let view: BackgroundBashView | undefined;
      let finish: (() => void) | undefined;
      const abort = () => { view?.close(); finish?.(); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        await ui.custom<void>((tui, theme, _keys, done) => {
          finish = () => done(undefined);
          view = new BackgroundBashView(source, theme, finish, () => tui.requestRender());
          if (signal.aborted) abort();
          return view;
        });
      } finally { signal.removeEventListener('abort', abort); await view?.dispose(); }
    },
  };
}

export { BackgroundBashCompletionComponent, registerBackgroundBashCompletionRenderer } from './ui/completion-message.js';
export type { BackgroundBashPresentationHost, BackgroundProcessViewSource } from './presentation.js';
export { ProcessViewPanel, presentProcessView } from './ui/process-view.js';
export type { ProcessViewNavigation } from './ui/process-view.js';
