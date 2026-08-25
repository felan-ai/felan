import { initTheme, InteractiveMode } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, type Component } from '@earendil-works/pi-tui';
import { describe, expect, it } from 'vitest';
import { showFelanUpdateNotification } from '../src/update-notification.js';

class TestContainer {
  readonly children: Component[] = [];

  addChild(component: Component): void {
    this.children.push(component);
  }
}

describe('Felan update notification', () => {
  it('uses Pi update styling with Felan instructions and no changelog', () => {
    initTheme(undefined, false);
    const chatContainer = new TestContainer();
    const mode = {
      chatContainer,
      showNewVersionNotification: InteractiveMode.prototype.showNewVersionNotification,
      ui: { requestRender() {} },
    } as unknown as InteractiveMode;

    showFelanUpdateNotification(mode, '0.14.5');

    const rendered = chatContainer.children.flatMap((component) => component.render(100));
    const plain = rendered.map((line) => stripTerminalSequences(line).trimEnd());
    expect(plain).toEqual([
      '',
      '─'.repeat(100),
      ' Update Available',
      ' New version 0.14.5 is available. Exit all Felan sessions, then run felan update',
      '─'.repeat(100),
    ]);

    const instruction = rendered[3] ?? '';
    const mutedColor = instruction.match(/(\x1b\[[0-9;]+m)New version/u)?.[1];
    const commandColor = instruction.match(/(\x1b\[[0-9;]+m)felan update/u)?.[1];
    expect(commandColor).toBeDefined();
    expect(commandColor).not.toBe(mutedColor);
    expect(Object.hasOwn(chatContainer, 'addChild')).toBe(false);
  });

  it('falls back to an accurate warning when Pi internals are unavailable', () => {
    const warnings: string[] = [];
    const mode = {
      showNewVersionNotification: () => {
        throw new Error('unexpected Pi notification');
      },
      showWarning: (warning: string) => warnings.push(warning),
    } as unknown as InteractiveMode;

    showFelanUpdateNotification(mode, '0.14.5');

    expect(warnings).toEqual([
      'Felan 0.14.5 is available. Exit all Felan sessions, then run felan update.',
    ]);
  });
});
