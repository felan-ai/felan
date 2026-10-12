import type { PromptHistoryPresentationHost } from './contracts.js';
import { PromptHistoryPicker } from './picker.js';
export { PromptHistoryPicker } from './picker.js';
export type { PromptHistoryNavigation } from './picker.js';

export const promptHistoryOverlay = { overlay: true as const,
  overlayOptions: { width: '80%' as const, minWidth: 64, maxHeight: '90%' as const, margin: 2 } };

export function createTuiPromptHistoryHost(): PromptHistoryPresentationHost {
  return { async show(ui, search, mode, signal) {
    let picker: PromptHistoryPicker | undefined; let abort = () => {};
    try {
      const result = await ui.custom<{ text: string } | undefined>((tui, theme, _keys, done) => {
        picker = new PromptHistoryPicker(search, theme, () => tui.requestRender(), done, mode);
        abort = () => done(undefined); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
        return picker;
      }, mode === 'overlay' ? promptHistoryOverlay : undefined);
      if (result && !signal.aborted) ui.setEditorText(result.text);
    } finally { signal.removeEventListener('abort', abort); picker?.dispose(); }
  } };
}
