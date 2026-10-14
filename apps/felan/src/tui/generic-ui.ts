import { Markdown, Text, matchesKey, type MarkdownTheme } from '@earendil-works/pi-tui';
import type { UiInput, UiValues } from '@felan-ai/session-protocol';
import type { InteractionPresenterUi } from '../client/presenters.js';
import { uiText, type GenericUiDriver } from '../client/ui.js';

export function createGenericTuiDriver(ui: InteractionPresenterUi): GenericUiDriver {
  const choose = async (message: string, choices: readonly { id: string; label: string }[], signal: AbortSignal) => {
    if (!await readText(ui, message, signal)) return undefined;
    const labels = choices.map((choice, index) => `${index + 1}. ${choice.label}`);
    const result = await ui.select('Choose an action', labels, { signal });
    if (signal.aborted || result === undefined) return undefined;
    const index = labels.indexOf(result);
    if (index < 0) throw new Error('Unknown UI selection.');
    return choices[index]!.id;
  };
  return {
    choose,
    display: async (message, signal) => { await readText(ui, message, signal); },
    fields: async (message: string, input: UiInput, signal: AbortSignal): Promise<UiValues | undefined> => {
      const values: UiValues = Object.create(null);
      for (const field of input.fields) {
        if (signal.aborted) return undefined;
        const title = `${uiText(message)}\n${uiText(field.label)}`;
        const initial = input.defaults && Object.hasOwn(input.defaults, field.id) ? input.defaults[field.id] : undefined;
        if (!field.required) {
          const presence = await ui.select(title, ['Enter a value', 'Omit this field'], { signal });
          if (presence === undefined) return undefined;
          if (presence === 'Omit this field') continue;
        }
        if (field.kind === 'enum' || field.kind === 'boolean') {
          const options = field.kind === 'boolean' ? [{ id: 'false', label: 'No' }, { id: 'true', label: 'Yes' }] : field.options;
          const labels = options.map((option, index) => `${index + 1}. ${uiText(option.label)}${option.id === String(initial) ? ' (default)' : ''}`);
          const result = await ui.select(title, labels, { signal });
          if (result === undefined) return undefined;
          const index = labels.indexOf(result);
          if (index < 0) throw new Error('Unknown field selection.');
          values[field.id] = field.kind === 'boolean' ? options[index]!.id === 'true' : options[index]!.id;
        } else if (field.kind === 'multi_select') {
          const selected = new Set(Array.isArray(initial) ? initial : []);
          while (!signal.aborted) {
            const labels = field.options.map((option, index) => `${index + 1}. [${selected.has(option.id) ? 'x' : ' '}] ${uiText(option.label)}`);
            const result = await ui.select(title, [...labels, 'Done'], { signal });
            if (result === undefined) return undefined;
            if (result === 'Done') break;
            const option = field.options[labels.indexOf(result)];
            if (!option) throw new Error('Unknown multi-selection.');
            if (selected.has(option.id)) selected.delete(option.id);
            else if (selected.size < field.maxSelections) selected.add(option.id);
            else ui.notify(`Select at most ${field.maxSelections} options.`, 'warning');
          }
          values[field.id] = [...selected];
        } else {
          const initialValue = initial === undefined ? '' : String(initial);
          const result = field.kind === 'string' && field.multiline
            ? await ui.editor(title, initialValue, { signal })
            : await ui.input(title, field.kind === 'string' ? field.placeholder : undefined, { signal, initialValue });
          if (result === undefined) return undefined;
          if (field.kind === 'number' && !result.trim()) throw new Error('A number is required.');
          values[field.id] = field.kind === 'number' ? Number(result) : result;
        }
      }
      return signal.aborted ? undefined : values;
    },
  };
}

async function readText(ui: InteractionPresenterUi, message: string, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  let finish = (_value: boolean) => {};
  const abort = () => finish(false);
  signal.addEventListener('abort', abort, { once: true });
  try {
    return await ui.custom<boolean>((tui, theme, _keys, done) => {
      finish = done;
      const plain = (text: string) => theme.fg('text', text);
      const markdownTheme: MarkdownTheme = { heading: plain, link: plain, linkUrl: plain, code: plain, codeBlock: plain,
        codeBlockBorder: plain, quote: plain, quoteBorder: plain, hr: plain, listBullet: plain,
        bold: text => theme.bold(text), italic: plain, strikethrough: plain, underline: plain };
      const body = new Markdown(uiText(message), 1, 0, markdownTheme);
      let offset = 0;
      if (signal.aborted) done(false);
      return {
        render(width) {
          const columns = Math.max(1, Math.floor(width));
          const rows = body.render(columns);
          const height = Math.max(1, tui.terminal.rows - 6);
          offset = Math.max(0, Math.min(offset, Math.max(0, rows.length - height)));
          return [...rows.slice(offset, offset + height), ...new Text('↑/↓ scroll · PgUp/PgDn page · Enter continue · Esc dismiss', 1, 0).render(columns)];
        },
        invalidate: () => body.invalidate(),
        handleInput(data) {
          if (matchesKey(data, 'escape')) done(false);
          else if (matchesKey(data, 'return')) done(true);
          else {
            const page = Math.max(1, tui.terminal.rows - 6);
            if (matchesKey(data, 'up')) offset--;
            if (matchesKey(data, 'down')) offset++;
            if (matchesKey(data, 'pageUp')) offset -= page;
            if (matchesKey(data, 'pageDown')) offset += page;
            tui.requestRender();
          }
        },
      };
    });
  } finally { signal.removeEventListener('abort', abort); }
}
