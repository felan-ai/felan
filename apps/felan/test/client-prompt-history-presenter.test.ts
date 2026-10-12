import { expect, it, vi } from 'vitest';
import type { Presentation } from '@felan-ai/session-protocol';
import { PROMPT_HISTORY_PRESENTER, splitPromptHistoryText } from '@felan-ai/ext-prompt-history/view';
import { registerPromptHistoryPresenter } from '../src/client/prompt-history-presenter.js';
import type { ClientInteractionPresenters, InteractionPresenterUi } from '../src/client/presenters.js';
import type { PromptHistoryPicker } from '@felan-ai/ext-prompt-history/tui';

function fixture() {
  let handler!: Parameters<ClientInteractionPresenters['registerCustom']>[1]; let items: Presentation[] = [];
  const listeners = new Set<() => void>(); const setEditorText = vi.fn(); let picker!: PromptHistoryPicker;
  const ui = { setEditorText, custom: vi.fn((factory: Parameters<InteractionPresenterUi['custom']>[0]) => new Promise(resolve => {
    picker = factory({ requestRender() {} } as never, { fg: (_: string, text: string) => text, bold: (text: string) => text } as never, {} as never, resolve) as PromptHistoryPicker;
  })) };
  const presenters = { registerCustom(_identity: unknown, value: typeof handler) { handler = value; return () => {}; } };
  const dispose = registerPromptHistoryPresenter(presenters, ui as never, { read: () => items, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } });
  return { call: (request: object, signal = new AbortController().signal) => handler(request as never, signal), dispose, setEditorText, ui,
    picker: () => picker, listeners, publish(data: object) { items = [{ id: 'prompt-history:view', kind: 'custom', presenter: PROMPT_HISTORY_PRESENTER, data: data as never }]; for (const listener of listeners) listener(); } };
}

it('uses the original live picker and returns only a selected opaque identifier', async () => {
  const f = fixture();
  try {
    f.publish({ viewId: 'view', generation: 1, version: 1, items: [{ id: 'opaque', text: 'needle preview', cwd: 'work', sessionLabel: 's', timestamp: 1 }], loading: false, scanned: 1, complete: true });
    const result = f.call({ viewId: 'view', generation: 1, kind: 'browse', scope: 'session', query: '', displayMode: 'inline' });
    await vi.waitFor(() => expect(f.picker().render(80).join('\n')).toContain('needle preview'));
    f.picker().handleInput('\r');
    expect(await result).toEqual({ viewId: 'view', generation: 1, action: 'choose', id: 'opaque' });
    expect(f.setEditorText).not.toHaveBeenCalled(); expect(f.listeners.size).toBe(0);
  } finally { f.dispose(); }
});

it('restores a cold transfer by requesting missing chunks and inserts only the complete text', async () => {
  const f = fixture(); const text = 'full😀\n"'.repeat(20000); const encoded = splitPromptHistoryText(text);
  try {
    expect(await f.call({ viewId: 'view', generation: 1, kind: 'text', index: 2, chunks: encoded.chunks.length, bytes: encoded.bytes })).toMatchObject({ action: 'chunk', index: 0 });
    for (const [index, part] of encoded.chunks.entries()) {
      f.publish({ viewId: 'view', generation: index + 2, index, text: part });
      const result = await f.call({ viewId: 'view', generation: index + 2, kind: 'text', index, chunks: encoded.chunks.length, bytes: encoded.bytes });
      expect(result).toMatchObject(index === encoded.chunks.length - 1 ? { action: 'insert' } : { action: 'chunk', index: index + 1 });
      expect(f.setEditorText).toHaveBeenCalledTimes(index === encoded.chunks.length - 1 ? 1 : 0);
    }
    expect(f.setEditorText).toHaveBeenCalledWith(text); expect(f.ui.custom).not.toHaveBeenCalled(); expect(f.listeners.size).toBe(0);
  } finally { f.dispose(); }
});

it('releases a pending chunk subscription on abort without changing the editor', async () => {
  const f = fixture(); const control = new AbortController();
  try {
    const waiting = f.call({ viewId: 'view', generation: 1, kind: 'text', index: 0, chunks: 1, bytes: 4 }, control.signal);
    const check = expect(waiting).rejects.toThrow(); control.abort(); await check;
    expect(f.listeners.size).toBe(0); expect(f.setEditorText).not.toHaveBeenCalled();
  } finally { f.dispose(); }
});
