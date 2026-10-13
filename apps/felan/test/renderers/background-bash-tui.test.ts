import { readFile } from 'node:fs/promises';
import type { ExtensionContext } from '@felan-ai/agent-core';
import { expect, it, vi } from 'vitest';
import type { BackgroundProcessViewSource } from '../../../../packages/ext-background-bash/src/presentation.js';
import { BackgroundBashView } from '../../src/tui/renderers/processes/background-bash-view.js';

it('keeps execution separate from the TUI implementation', async () => {
  const source = await readFile(new URL('../../../../packages/ext-background-bash/src/index.ts', import.meta.url), 'utf8');
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

