import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { Component, TUI } from '@earendil-works/pi-tui';
import { TuiDialogs } from '../src/tui/dialogs.js';
import { createClientKeybindings } from '../src/tui/keybindings.js';
import { createSetupUi } from '../src/tui/setup-ui.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function fixture() {
  let component!: Component; const hide = vi.fn();
  const tui = { requestRender: vi.fn(), hasOverlay: () => false, showOverlay(value: Component) { component = value; return { hide }; } } as unknown as TUI;
  const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text } as Theme;
  const dialogs = new TuiDialogs(tui);
  const ui = createSetupUi(tui, dialogs, () => theme, createClientKeybindings());
  return { ui, dialogs, hide, input: (data: string) => component.handleInput?.(data), render: () => component.render(90).join('\n') };
}

it('uses the unchecked dependency checklist and returns skip selections only on submit', async () => {
  const f = fixture(); const signal = new AbortController();
  try {
    const result = f.ui.checklist([{ id: 'first', label: 'install: First', description: 'Reviewed dependency' }], signal.signal);
    expect(f.render()).toContain('[ ]'); expect(f.render()).not.toContain('[✓]');
    f.input('\r'); expect(await result).toEqual([]); expect(f.hide).toHaveBeenCalledOnce();
    const cancelled = f.ui.checklist([{ id: 'first', label: 'install: First', description: '' }], signal.signal);
    f.input(' '); expect(f.render()).toContain('[✓]'); signal.abort(); expect(await cancelled).toBeUndefined();
  } finally { f.dialogs.dispose(); }
});

it('stops the existing progress loader when a job completes or its view is replaced', async () => {
  const f = fixture(); const abort = new AbortController();
  try {
    const result = f.ui.progress({ id: 'job', kind: 'dependencies', state: 'running', message: 'Installing reviewed dependency' }, abort.signal);
    expect(f.render()).toContain('Installing reviewed dependency'); expect(vi.getTimerCount()).toBeGreaterThan(0);
    abort.abort(); expect(await result).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
  } finally { f.dialogs.dispose(); }
});

it('opens a dependency link picker only on explicit input and stops its loader', async () => {
  const f = fixture(); const abort = new AbortController();
  try {
    const result = f.ui.progress({ id: 'job', kind: 'dependencies', state: 'running', message: 'Authorize', links: [{ label: 'Login', url: 'https://example.test' }] }, abort.signal);
    expect(f.render()).toContain('L opens setup links'); f.input('l'); expect(await result).toBe('links'); expect(vi.getTimerCount()).toBe(0);
  } finally { f.dialogs.dispose(); }
});

it('shows the login title, authorization URL, instructions and a masked manual response together', async () => {
  const f = fixture(); const abort = new AbortController();
  try {
    const result = f.ui.login({ id: 'job', kind: 'login', state: 'waiting', message: 'Waiting for authorization',
      links: [{ label: 'Open this page and authorize', url: 'https://example.test/authorize' }],
      prompt: { id: 'code', kind: 'input', message: 'Paste redirect URL or code', secret: true } }, 'Fixture provider', abort.signal);
    expect(f.render()).toContain('Login to Fixture provider');
    expect(f.render()).toContain('https://example.test/authorize'); expect(f.render()).toContain('Open this page and authorize');
    expect(f.render()).toContain('Waiting for authorization'); expect(f.render()).toContain('Paste redirect URL or code');
    f.input('private-code'); expect(f.render()).not.toContain('private-code'); expect(f.render()).toContain('************');
    f.input('\r'); expect(await result).toBe('private-code'); expect(f.hide).toHaveBeenCalledOnce();
  } finally { f.dialogs.dispose(); }
});

it('keeps the device code visible with progress and lets Escape cancel without another step', async () => {
  const f = fixture(); const abort = new AbortController();
  try {
    const result = f.ui.login({ id: 'job', kind: 'login', state: 'running', message: 'Checking authorization…',
      links: [{ label: 'Enter code: TEST-CODE', url: 'https://example.test/device' }] }, 'Provider', abort.signal);
    expect(f.render()).toContain('TEST-CODE'); expect(f.render()).toContain('https://example.test/device');
    expect(f.render()).toContain('Checking authorization…'); f.input('\x1b'); expect(await result).toBeUndefined();
  } finally { f.dialogs.dispose(); }
});

it('supports provider selection prompts in the login dialog', async () => {
  const f = fixture(); const abort = new AbortController();
  try {
    const result = f.ui.login({ id: 'job', kind: 'login', state: 'waiting', message: '',
      prompt: { id: 'account', kind: 'select', message: 'Choose account', choices: [{ id: 'id', label: 'Account name' }] } }, 'Provider', abort.signal);
    expect(f.render()).toContain('Choose account'); expect(f.render()).toContain('Account name');
    f.input('\r'); expect(await result).toBe('id');
  } finally { f.dialogs.dispose(); }
});


it('prefills provider search, matches fuzzy names and handles Escape as back', async () => {
  const f = fixture(); const signal = new AbortController().signal;
  try {
    const choices = [{ value: 'first:oauth', label: 'Alpha Provider' }, { value: 'second:api_key', label: 'Beta Provider' }];
    const selected = f.ui.providers('Select provider to configure:', choices, 'btp', signal);
    expect(f.render()).toContain('Beta Provider'); expect(f.render()).not.toContain('Alpha Provider');
    f.input('\r'); expect(await selected).toBe('second:api_key');
    const back = f.ui.providers('Select provider to configure:', choices, undefined, signal);
    f.input('\x1b'); expect(await back).toBeUndefined();
  } finally { f.dialogs.dispose(); }
});
