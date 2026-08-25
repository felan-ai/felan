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
  // Pi does not expose a customizable update notification yet. Adapt the
  // components it adds so Felan retains Pi's active theme and border styling.
  container.addChild = (component) => {
    const text = Reflect.get(component, 'text');
    if (typeof text === 'string') {
      if (text.includes('Changelog:')) return;

      const setText = Reflect.get(component, 'setText');
      if (typeof setText === 'function' && text.includes('pi update')) {
        const instruction = text
          .replace(
            `New version ${version} is available. Run `,
            `New version ${version} is available. Exit all Felan sessions, then run `,
          )
          .replace('pi update', 'felan update');
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
