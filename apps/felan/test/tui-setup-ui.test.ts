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

it('opens a link picker only on explicit input and stops its loader', async () => {
  const f = fixture(); const abort = new AbortController();
  try {
    const result = f.ui.progress({ id: 'job', kind: 'login', state: 'running', message: 'Authorize', links: [{ label: 'Login', url: 'https://example.test' }] }, abort.signal);
    expect(f.render()).toContain('L opens setup links'); f.input('l'); expect(await result).toBe('links'); expect(vi.getTimerCount()).toBe(0);
  } finally { f.dialogs.dispose(); }
});
