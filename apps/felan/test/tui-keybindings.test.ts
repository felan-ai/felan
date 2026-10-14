import { expect, it } from 'vitest';
import { createClientKeybindings, parseClientKeybindings } from '../src/tui/keybindings.js';

it('keeps model, thinking, follow-up and disclosure shortcuts in the client', () => {
  const keys = createClientKeybindings();
  expect(keys.matches('\x0c', 'app.model.select')).toBe(true);
  expect(keys.matches('\x10', 'app.model.cycleForward')).toBe(true);
  expect(keys.matches('\x1b[Z', 'app.thinking.cycle')).toBe(true);
  expect(keys.matches('\x1b\r', 'app.message.followUp')).toBe(true);
  expect(keys.matches('\x0f', 'app.tools.expand')).toBe(true);
});

it('supports client-local keybinding overrides without loading Pi private modules', () => {
  const keys = createClientKeybindings({ 'app.model.select': 'alt+m' });
  expect(keys.matches('\x0c', 'app.model.select')).toBe(false);
  expect(keys.matches('\x1bm', 'app.model.select')).toBe(true);
});

it('provides the session panel shortcuts used by memory and selection views', () => {
  const keys = createClientKeybindings();
  for (const [data, action] of [['\x0e', 'app.session.toggleNamedFilter'], ['\x10', 'app.session.togglePath'], ['\x13', 'app.session.toggleSort'], ['\x12', 'app.session.rename'], ['\x04', 'app.session.delete']] as const) {
    expect(keys.matches(data, action)).toBe(true);
  }
  expect(keys.getKeys('app.session.deleteNoninvasive')).toEqual(['ctrl+backspace']);
});

it('validates key syntax and supports disabled bindings and configured session actions', () => {
  const keys = createClientKeybindings(parseClientKeybindings({ 'app.exit': [], 'app.session.resume': 'alt+r', 'tui.select.down': 'ctrl+n' }));
  expect(keys.matches('\x04', 'app.exit')).toBe(false);
  expect(keys.matches('\x1br', 'app.session.resume')).toBe(true);
  expect(keys.matches('\x0e', 'tui.select.down')).toBe(true);
  expect(() => parseClientKeybindings({ 'app.exit': 'unknown+d' })).toThrow('Invalid keybinding');
  expect(parseClientKeybindings({ 'tui.editor.cursorDown': ['pageDown', 'ctrl+shift+down'], 'app.clear': 'ctrl++' })).toBeDefined();
});
