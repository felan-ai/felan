import type { InteractiveMode } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';

interface ChatContainer {
  addChild(component: Component): void;
}

interface InteractiveModeNotificationInternals {
  readonly chatContainer?: ChatContainer;
}

interface TextComponent extends Component {
  setText(text: string): void;
}

export function showFelanUpdateNotification(mode: InteractiveMode, version: string): void {
  const internals = mode as unknown as InteractiveModeNotificationInternals;
  const container = internals.chatContainer;
  if (!container) {
    mode.showWarning(
      `Felan ${version} is available. Exit all Felan sessions, then run felan update.`,
    );
    return;
  }

  const ownAddChild = Object.getOwnPropertyDescriptor(container, 'addChild');
  const addChild = container.addChild;
  // The upstream API does not expose a customizable update notification yet.
  // Adapt its components so Felan retains the active theme and border styling.
  container.addChild = (component) => {
    const text = Reflect.get(component, 'text');
    if (typeof text === 'string') {
      if (text.includes('Changelog:')) return;

      const setText = Reflect.get(component, 'setText');
      const instructionPrefix = `New version ${version} is available. Run `;
      const instructionStart = text.indexOf(instructionPrefix);
      if (typeof setText === 'function' && instructionStart >= 0) {
        const actionStart = instructionStart + instructionPrefix.length;
        const styledAction = text.slice(actionStart).replace(
          /(\x1b\[[0-9;]*m)[^\x1b]+(?=\x1b\[[0-9;]*m$)/u,
          '$1felan update',
        );
        const instruction = text.slice(0, instructionStart)
          + `New version ${version} is available. Exit all Felan sessions, then run `
          + styledAction;
        setText.call(component as TextComponent, instruction);
      }
    }
    addChild.call(container, component);
  };

  try {
    mode.showNewVersionNotification({ version });
  } finally {
    if (ownAddChild) Object.defineProperty(container, 'addChild', ownAddChild);
    else Reflect.deleteProperty(container, 'addChild');
  }
}
