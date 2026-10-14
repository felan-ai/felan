import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setKeybindings, stripTerminalSequences, type Component, type TUI } from '@earendil-works/pi-tui';
import { submitTuiInput } from '../src/tui/commands.js';
import { TuiDialogs } from '../src/tui/dialogs.js';
import { createClientKeybindings } from '../src/tui/keybindings.js';
import type { TuiSessionController } from '../src/tui/controller.js';

beforeEach(() => setKeybindings(createClientKeybindings()));
afterEach(() => setKeybindings(createClientKeybindings()));

function fixture() {
  let component: Component | undefined;
  const tui = { requestRender: vi.fn(), showOverlay(value: Component) { component = value; return { hide: () => { component = undefined; } }; } } as unknown as TUI;
  const dialogs = new TuiDialogs(tui);
  const controller = {
    sessionId: 'session', setNotice: vi.fn(), snapshot: { model: { provider: 'z', id: 'current' }, thinking: 'xhigh',
      catalog: { models: [
        { provider: 'a', id: 'first', label: 'First', thinking: [] },
        { provider: 'z', id: 'current', label: 'Current model', thinking: ['minimal', 'low', 'high', 'xhigh', 'max'] },
        { provider: 'z', id: 'default', label: 'Default', thinking: [] },
      ] } },
    perform: vi.fn(async (op: string) => ({ outcome: 'accepted', result: op === 'config.get'
      ? { values: { defaultModel: 'z/default', defaultThinking: 'xhigh' } } : {} })),
  };
  return { dialogs, controller, input: (data: string) => component?.handleInput?.(data),
    render: () => stripTerminalSequences(component?.render(100).join('\n') ?? ''),
    submit: (command: string) => submitTuiInput(controller as unknown as TuiSessionController, dialogs, command, { cwd: '/', exit() {} }) };
}

it.each([
  ['/model', '\r', true, 'Default model: z/current'],
  ['/model', '\x13', false, 'Model: current'],
  ['/thinking', '\r', false, 'Thinking level: xhigh'],
  ['/thinking', '\x13', true, 'Default thinking level: xhigh'],
] as const)('%s with %j preserves current selection and the correct save scope', async (command, key, persist, notice) => {
  const f = fixture(); const pending = f.submit(command);
  await vi.waitFor(() => expect(f.render()).toContain(command === '/model' ? 'Current model' : 'Extra-high reasoning'));
  const rendered = f.render();
  if (command === '/model') {
    expect(rendered).toContain('→ ✓ current [z]');
    expect(rendered.indexOf('current [z]')).toBeLessThan(rendered.indexOf('default [z] · default'));
    expect(rendered.indexOf('default [z]')).toBeLessThan(rendered.indexOf('first [a]'));
    expect(rendered).toContain('enter set as default · ctrl+s select for this session');
  } else {
    expect(rendered).toContain('→ ✓ xhigh · default');
    expect(rendered).toContain('enter select for this session · ctrl+s set as default');
  }
  f.input(key); expect(await pending).toBe(true);
  const calls = f.controller.perform.mock.calls;
  expect(calls.some(([op]) => op === 'config.set')).toBe(persist);
  expect(f.controller.setNotice).toHaveBeenLastCalledWith(notice);
  f.dialogs.dispose();
});

it('moves from the current thinking level to max without saving a default', async () => {
  const f = fixture(); const pending = f.submit('/thinking');
  await vi.waitFor(() => expect(f.render()).toContain('Extra-high reasoning'));
  f.input('\x1b[B'); expect(f.render()).toContain('Maximum reasoning'); f.input('\r');
  expect(await pending).toBe(true);
  expect(f.controller.perform).toHaveBeenCalledWith('set_thinking', { thinking: 'max' }, 'session');
  expect(f.controller.perform).not.toHaveBeenCalledWith('config.set', expect.anything()); f.dialogs.dispose();
});

it('shows effective generic selection keys and preserves the current item', async () => {
  const f = fixture();
  const choice = f.dialogs.select('Login method', [{ value: 'oauth', label: 'OAuth' }, { value: 'api', label: 'API key' }], { initialValue: 'api' });
  expect(f.render()).toContain('↑↓ navigate · enter select · escape/ctrl+c cancel');
  expect(f.render()).toContain('→ API key'); f.input('\x1b'); expect(await choice).toBeUndefined();
  setKeybindings(createClientKeybindings({ 'tui.select.up': 'ctrl+p', 'tui.select.down': 'ctrl+n', 'tui.select.confirm': 'alt+s', 'tui.select.cancel': 'alt+x' }));
  const remapped = f.dialogs.select('Login method', [{ value: 'api', label: 'API key' }]);
  expect(f.render()).toContain('ctrl+p/ctrl+n navigate · alt+s select · alt+x cancel');
  f.input('\x1bx'); expect(await remapped).toBeUndefined(); f.dialogs.dispose();
});

it('omits a thinking default marker when the provider has no effective default', async () => {
  const f = fixture();
  f.controller.perform.mockResolvedValue({ outcome: 'accepted', result: { values: {} } } as never);
  const pending = f.submit('/thinking');
  await vi.waitFor(() => expect(f.render()).toContain('Extra-high reasoning'));
  expect(f.render()).not.toContain('· default');
  expect(f.controller.perform).toHaveBeenCalledWith('config.get', { scope: 'global' }, 'session');
  f.input('\x1b'); expect(await pending).toBe(false); f.dialogs.dispose();
});

it('marks the provider effective thinking default and updates an existing model override on save', async () => {
  const f = fixture();
  f.controller.perform.mockImplementation(async (op: string) => ({ outcome: 'accepted', result: op === 'config.get'
    ? { values: { defaultThinking: 'low', modelThinkingLevels: { 'z/current': 'low', 'z/other': 'high' } } } : {} }) as never);
  const pending = f.submit('/thinking');
  await vi.waitFor(() => expect(f.render()).toContain('low · default'));
  expect(f.render()).not.toContain('xhigh · default');
  f.input('\x13'); expect(await pending).toBe(true);
  expect(f.controller.perform).toHaveBeenCalledWith('config.set', { scope: 'global', values: { defaultThinking: 'xhigh',
    modelThinkingLevels: { 'z/current': 'xhigh', 'z/other': 'high' } } });
  f.dialogs.dispose();
});

it.each(['/model', '/thinking'])('%s reports the retained session change when default persistence fails', async command => {
  const f = fixture();
  const original = f.controller.perform.getMockImplementation()!;
  f.controller.perform.mockImplementation(async (op: string) => op === 'config.set'
    ? { outcome: 'rejected', error: { code: 'unavailable' } } as never : original(op));
  const pending = f.submit(command);
  await vi.waitFor(() => expect(f.render()).toContain(command === '/model' ? 'Current model' : 'Extra-high reasoning'));
  f.input(command === '/model' ? '\r' : '\x13'); expect(await pending).toBe(true);
  expect(f.controller.setNotice).toHaveBeenLastCalledWith(expect.stringContaining('set for this session; saving default failed'));
  f.dialogs.dispose();
});

it.each(['/model', '/thinking'])('%s reports a thrown save failure after applying the session change', async command => {
  const f = fixture(); const original = f.controller.perform.getMockImplementation()!;
  f.controller.perform.mockImplementation(async (op: string) => { if (op === 'config.set') throw new Error('disconnected'); return original(op); });
  const pending = f.submit(command);
  await vi.waitFor(() => expect(f.render()).toContain(command === '/model' ? 'Current model' : 'Extra-high reasoning'));
  f.input(command === '/model' ? '\r' : '\x13'); expect(await pending).toBe(true);
  expect(f.controller.setNotice).toHaveBeenLastCalledWith(expect.stringContaining('set for this session; saving default failed'));
  f.dialogs.dispose();
});
