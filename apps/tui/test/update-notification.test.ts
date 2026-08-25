import type { InteractiveMode } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import { showFelanUpdateNotification } from '../src/update-notification.js';

class TestText implements Component {
  constructor(public text: string) {}

  setText(text: string): void {
    this.text = text;
  }

  render(): string[] {
    return [this.text];
  }
}

class TestContainer {
  readonly children: Component[] = [];

  addChild(component: Component): void {
    this.children.push(component);
  }
}

describe('Felan update notification', () => {
  it('uses Pi update styling with Felan instructions and no changelog', () => {
    const chatContainer = new TestContainer();
    const mode = {
      chatContainer,
      showNewVersionNotification({ version }: { version: string }) {
        chatContainer.addChild(new TestText('Update Available'));
        chatContainer.addChild(new TestText(`New version ${version} is available. Run pi update`));
        chatContainer.addChild(new TestText('Changelog: https://pi.dev/changelog'));
      },
    } as unknown as InteractiveMode;

    showFelanUpdateNotification(mode, '0.14.5');

    expect(chatContainer.children.map((component) => component.render(80)[0])).toEqual([
      'Update Available',
      'New version 0.14.5 is available. Exit all Felan sessions, then run felan update',
    ]);
    expect(Object.hasOwn(chatContainer, 'addChild')).toBe(false);
  });
});
