import { beforeAll, expect, it, vi } from 'vitest';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { KeybindingsManager, TUI_KEYBINDINGS, setKeybindings } from '@earendil-works/pi-tui';
import { createClientAgentViews } from '../src/client/agents-presenter.js';

beforeAll(() => { initTheme('dark', false); setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)); });
const settings = () => ({ hideThinking: false, showImages: false, imageWidthCells: 60, outputPad: 1, toolMode: 'grouped' as const });
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
function client() {
  return { status: 'disconnected', readAttachment: () => undefined, subscribe: vi.fn(() => vi.fn()), request: vi.fn(), attach: vi.fn(), detach: vi.fn() };
}

it('opens a client-owned navigator without a custom interaction', async () => {
  let done!: () => void; let component: { render(width: number): string[] } | undefined;
  const off = vi.fn();
  const ui = { notify: vi.fn(), onTerminalInput: () => off, custom: vi.fn((factory: Function) => new Promise<void>(resolve => {
    done = resolve; component = factory({ terminal: { rows: 12, columns: 80 }, requestRender: vi.fn() }, theme, { matches: () => false }, resolve);
  })) };
  const views = createClientAgentViews(client() as never, 'root', ui as never, settings);
  try {
    await views.open();
    expect(component?.render(80).join('\n')).toContain('Agent navigator');
    expect(ui.custom).toHaveBeenCalledTimes(1);
    await views.open(); expect(ui.custom).toHaveBeenCalledTimes(1);
  } finally { done?.(); await views.dispose(); }
  expect(off).toHaveBeenCalled();
});

it('does not mount after disposal if the UI factory was delayed', async () => {
  let factory!: Function; let finish!: () => void;
  const ui = { notify: vi.fn(), onTerminalInput: () => vi.fn(), custom: (next: Function) => {
    factory = next; return new Promise<void>(resolve => { finish = resolve; });
  } };
  const views = createClientAgentViews(client() as never, 'root', ui as never, settings);
  const opening = views.open().then(() => 'mounted', () => 'cancelled');
  await views.dispose(); expect(await opening).toBe('cancelled');
  const empty = factory({}, {}, {}, finish);
  expect(empty.render(80)).toEqual([]);
});

it('does not claim to open an unsupported UI which never mounted its factory', async () => {
  const views = createClientAgentViews(client() as never, 'root', { notify: vi.fn(), onTerminalInput: () => vi.fn(), custom: async () => undefined } as never, settings);
  try { await expect(views.open()).rejects.toThrow('not mounted'); }
  finally { await views.dispose(); }
});

it('keeps the tool renderer resolver client-owned when creating the agent host', async () => {
  const renderer = { renderCall: vi.fn(() => ({ render: () => ['client'], invalidate() {} })) };
  const present = vi.fn(() => renderer);
  const views = createClientAgentViews(client() as never, 'root', { notify: vi.fn(), onTerminalInput: () => vi.fn(), custom: async () => undefined } as never, settings, present);
  try { expect(views.host.toolPresentation('read')).toBe(renderer); expect(present).toHaveBeenCalledWith('read'); }
  finally { await views.dispose(); }
});
