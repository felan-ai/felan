import { Key, Markdown, matchesKey, truncateToWidth, type MarkdownTheme } from '@earendil-works/pi-tui';
import type { UiActionRequest, UiPresentation } from '@felan-ai/session-protocol';
import type { InteractionPresenterUi } from '../../client/presenters.js';
import { decodeUiMarkdown, uiText } from '../../client/ui.js';
import { createElementNavigation } from './navigation.js';
export { MEMORY_HISTORY_HINT } from '../../memory/ui.js';

const navigation = createElementNavigation<{ selectedId?: string; scroll: number }>();

export async function presentMemoryHistory(element: UiPresentation, ui: Pick<InteractionPresenterUi, 'custom' | 'input'>,
  signal: AbortSignal): Promise<UiActionRequest | undefined> {
  if (element.kind !== 'view' && element.kind !== 'document') throw new Error('Expected a memory history view or document.');
  if (signal.aborted) return undefined;
  const initial = navigation.get(element.id);
  let selected = element.kind === 'view' ? Math.max(0, element.items.findIndex(item => item.id === initial?.selectedId)) : 0;
  let offset = initial?.scroll ?? 0;
  let finish = (_value: UiActionRequest | undefined) => {};
  const abort = () => finish(undefined);
  signal.addEventListener('abort', abort, { once: true });
  try {
    const result = await ui.custom<UiActionRequest | undefined>((tui, theme, _keybindings, done) => {
      finish = done;
      const available = (id: string) => element.actions.some(action => action.id === id);
      const action = (id: string) => {
        const choice = element.actions.find(action => action.id === id);
        const item = element.kind === 'view' ? element.items[selected] : undefined;
        if (!choice || choice.target === 'item' && !item) return;
        done({ elementId: element.id, revision: element.revision, actionId: id, outcome: choice.outcome,
          ...(choice.target === 'item' ? { itemId: item!.id } : {}), values: {} });
      };
      const plain = (text: string) => theme.fg('text', text);
      const markdownTheme: MarkdownTheme = {
        heading: text => theme.fg('accent', text), link: plain, linkUrl: plain, code: plain, codeBlock: plain,
        codeBlockBorder: text => theme.fg('border', text), quote: plain, quoteBorder: plain, hr: plain, listBullet: plain,
        bold: text => theme.bold(text), italic: plain, strikethrough: plain, underline: plain,
      };
      const body = element.kind === 'document' ? new Markdown(uiText(decodeUiMarkdown(element.markdown)), 1, 0, markdownTheme) : undefined;
      const hasRows = element.kind === 'document' || element.items.length > 0;
      const hints = [hasRows && '↑↓ navigate', element.kind === 'view' && hasRows && available('inspect') && 'Enter inspect', available('previous') && '← previous', available('next') && '→ next',
        element.kind === 'view' && element.query && 'Ctrl+F search', available('refresh') && 'Ctrl+R refresh',
        available('back') && 'Backspace back', available('close') && 'q close', 'Esc close'].filter(Boolean).join(' · ');
      if (signal.aborted) abort();
      return {
        render(width) {
          const height = Math.max(1, tui.terminal.rows - 6);
          const rows = body ? body.render(width) : element.kind === 'view' ? element.items.length ? element.items.map((item, index) =>
            `${index === selected ? '›' : ' '} ${element.fields.map(field => `${uiText(field.label)}: ${uiText(String(item.values[field.id] ?? ''))}`).join(' · ')}`)
            : [theme.fg('dim', element.query?.values.query ? 'No matching memory runs.' : 'No retained memory runs.')] : [];
          if (element.kind === 'view') {
            if (selected < offset) offset = selected;
            if (selected >= offset + height) offset = selected - height + 1;
          }
          offset = Math.max(0, Math.min(offset, rows.length - height));
          return [theme.fg('accent', uiText(element.title)), uiText(element.fallback), ...rows.slice(offset, offset + height).map(row => truncateToWidth(row, width)),
            truncateToWidth(hints, width)];
        },
        invalidate: () => body?.invalidate(),
        handleInput(data) {
          if (matchesKey(data, Key.escape)) { if (available('close')) action('close'); else done(undefined); return; }
          const id = data === 'q' ? 'close' : matchesKey(data, Key.backspace) ? 'back' : matchesKey(data, Key.left) ? 'previous'
            : matchesKey(data, Key.right) ? 'next' : matchesKey(data, Key.ctrl('r')) ? 'refresh'
              : element.kind === 'view' && matchesKey(data, Key.ctrl('f')) ? element.query?.actionId
                : element.kind === 'view' && matchesKey(data, Key.enter) ? 'inspect' : undefined;
          if (id) { action(id); return; }
          const page = Math.max(1, tui.terminal.rows - 6);
          const delta = matchesKey(data, Key.up) ? -1 : matchesKey(data, Key.down) ? 1
            : matchesKey(data, Key.pageUp) ? -page : matchesKey(data, Key.pageDown) ? page : 0;
          if (element.kind === 'view') selected = Math.max(0, Math.min(element.items.length - 1,
            matchesKey(data, Key.home) ? 0 : matchesKey(data, Key.end) ? element.items.length - 1 : selected + delta));
          else offset = matchesKey(data, Key.home) ? 0 : matchesKey(data, Key.end) ? Number.MAX_SAFE_INTEGER : Math.max(0, offset + delta);
          tui.requestRender();
        },
      };
    }, { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', margin: 0 } });
    if (signal.aborted || !result) return undefined;
    if (element.kind === 'view' && element.query?.actionId === result.actionId) {
      const action = element.actions.find(action => action.id === result.actionId)!;
      const query = await ui.input(uiText(action.label), undefined, { signal, initialValue: String(element.query.values.query ?? '') });
      return query === undefined || signal.aborted ? undefined : { ...result, values: { query } };
    }
    return result;
  } finally {
    navigation.set(element.id, { ...(element.kind === 'view' && element.items[selected] ? { selectedId: element.items[selected]!.id } : {}), scroll: offset });
    signal.removeEventListener('abort', abort);
  }
}
