import type { KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent';
import type { Component, TUI } from '@earendil-works/pi-tui';
import type { InteractionPresenterUi } from '../client/presenters.js';
import { TuiDialogs } from './dialogs.js';
import type { createClientKeybindings } from './keybindings.js';

export function createPresentationUi(tui: TUI, dialogs: TuiDialogs, theme: Theme | (() => Theme),
  keybindings: ReturnType<typeof createClientKeybindings>, notify: InteractionPresenterUi['notify']): InteractionPresenterUi {
  return {
    select: (title, choices, options) => dialogs.select(title, choices.map(value => ({ value, label: value })), options),
    confirm: (title, message, options) => dialogs.confirm(title, message, options),
    input: (title, placeholder, options) => dialogs.input(title, options?.initialValue ?? '', { ...options, ...(placeholder ? { placeholder } : {}) }),
    editor: (title, initial, options) => dialogs.editor(title, initial, options),
    notify,
    onTerminalInput: handler => tui.addInputListener(handler),
    custom: async <T>(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (result: T) => void) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
      options?: Parameters<InteractionPresenterUi['custom']>[1]): Promise<T> => {
      // Pi's callback uses a nominal class type; only its public keybinding API is provided by the client.
      const result = await dialogs.custom<T>(done => factory(tui, typeof theme === 'function' ? theme() : theme, keybindings as unknown as KeybindingsManager, done), options);
      return result as T;
    },
  };
}
