import { readFile } from 'node:fs/promises';
import type { ExtensionContext } from '@felan-ai/agent-core';
import { expect, it, vi } from 'vitest';
import type { BackgroundProcessViewSource } from '../src/presentation.js';
import { createTuiBackgroundBashHost } from '../src/tui.js';
import { BackgroundBashView } from '../src/ui/background-bash-view.js';

it('keeps execution separate from the TUI implementation', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/from ['"][^'"]*(?:pi-tui|\.\/ui\/)/u);
  expect(source).not.toContain('.ui.theme');
});

it('closes synchronously and joins an in-flight refresh without further reads', async () => {
  let resolve!: (jobs: []) => void;
  const source: BackgroundProcessViewSource = { list: vi.fn(() => new Promise<[]>(done => { resolve = done; })),
    tail: vi.fn(), stop: vi.fn() };
  const render = vi.fn();
  const view = new BackgroundBashView(source, { fg: (_key: string, text: string) => text, bold: (text: string) => text } as ExtensionContext['ui']['theme'], vi.fn(), render);
  view.close(); let disposed = false;
  const pending = view.dispose().then(() => { disposed = true; });
  await Promise.resolve(); expect(disposed).toBe(false);
  const count = render.mock.calls.length; resolve([]); await pending;
  expect(source.tail).not.toHaveBeenCalled(); expect(render).toHaveBeenCalledTimes(count);
});

it('aborts presentation and settles its read before returning', async () => {
  let resolve!: (jobs: []) => void; let opened!: () => void;
  const ready = new Promise<void>(done => { opened = done; });
  const source: BackgroundProcessViewSource = { list: () => new Promise<[]>(done => { resolve = done; }), tail: vi.fn(), stop: vi.fn() };
  const custom = vi.fn((factory: (...args: unknown[]) => unknown) => new Promise<void>(done => {
    factory({ requestRender() {} }, { fg: (_key: string, text: string) => text, bold: (text: string) => text }, {}, done); opened();
  }));
  const control = new AbortController(); let finished = false;
  const pending = createTuiBackgroundBashHost().show({ custom } as unknown as ExtensionContext['ui'], source, control.signal).then(() => { finished = true; });
  await ready; control.abort(); await Promise.resolve(); expect(finished).toBe(false);
  resolve([]); await pending; expect(finished).toBe(true);
});
