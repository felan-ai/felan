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
      `Felan Code ${version} is available. Exit all Felan Code sessions, then run felan update.`,
    );
    return;
  }

  const ownAddChild = Object.getOwnPropertyDescriptor(container, 'addChild');
  const addChild = container.addChild;
  // The upstream API does not expose a customizable update notification yet.
  // Adapt its components so Felan retains the active theme and border styling.
  container.addChild = (component) => {
    const text = Reflect.get(component, 'text');
    const build = Reflect.get(component, 'build');
    const currentText = typeof build === 'function' ? build.call(component) : text;
    if (typeof currentText === 'string' && currentText.includes('Changelog:')) return;

    if (typeof build === 'function') {
      Reflect.set(component, 'build', () => adaptUpdateInstruction(build.call(component), version));
    } else if (typeof text === 'string') {
      const setText = Reflect.get(component, 'setText');
      if (typeof setText === 'function') {
        setText.call(component as TextComponent, adaptUpdateInstruction(text, version));
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

function adaptUpdateInstruction(text: string, version: string): string {
  const instructionPrefix = `New version ${version} is available. Run `;
  const instructionStart = text.indexOf(instructionPrefix);
  if (instructionStart < 0) return text;

  const actionStart = instructionStart + instructionPrefix.length;
  const styledAction = text.slice(actionStart).replace(
    /(\x1b\[[0-9;]*m)[^\x1b]+(?=\x1b\[[0-9;]*m$)/u,
    '$1felan update',
  );
  return text.slice(0, instructionStart)
    + `New version ${version} is available. Exit all Felan Code sessions, then run `
    + styledAction;
}
