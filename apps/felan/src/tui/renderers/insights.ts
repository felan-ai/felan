import { createElementNavigation } from './navigation.js';
import { decodeUiMarkdown } from '../../client/ui.js';
import type { ExtensionContext, ThemeColor, UiActionRequest, UiPresentation } from '@felan-ai/agent-core';
import { Key, Markdown, matchesKey, stripTerminalSequences, truncateToWidth, type MarkdownTheme } from '@earendil-works/pi-tui';

const positions = createElementNavigation<number>();

export async function presentInsightsDocument(element: UiPresentation, ui: Pick<ExtensionContext['ui'], 'custom'>,
  signal: AbortSignal): Promise<UiActionRequest | undefined> {
  if (element.kind !== 'document') throw new Error('Expected an insights report document.');
  if (signal.aborted) return undefined;
  let offset = positions.get(element.id) ?? 0;
  let finish = (_value: UiActionRequest | undefined) => {};
  const abort = () => finish(undefined);
  signal.addEventListener('abort', abort, { once: true });
  try {
    const result = await ui.custom<UiActionRequest | undefined>((tui, theme, _keys, done) => {
      finish = done;
      const color = (name: ThemeColor) => (text: string) => theme.fg(name, text);
      const markdownTheme: MarkdownTheme = {
        heading: color('accent'), link: color('accent'), linkUrl: color('dim'), code: color('success'),
        codeBlock: color('text'), codeBlockBorder: color('border'), quote: color('muted'), quoteBorder: color('border'),
        hr: color('border'), listBullet: color('accent'), bold: text => theme.bold(text),
        italic: text => theme.italic(text), strikethrough: text => theme.strikethrough(text), underline: text => theme.underline(text),
      };
      const safe = (text: string) => stripTerminalSequences(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, '');
      const body = new Markdown(safe(decodeUiMarkdown(element.markdown)), 1, 0, markdownTheme);
      const navigation = element.actions.filter(action => action.target === 'element' && ['previous', 'next'].includes(action.id));
      
      if (signal.aborted) abort();
      return {
        render(width) {
          const height = Math.max(1, tui.terminal.rows - 6); const rows = body.render(width);
          offset = Math.max(0, Math.min(offset, rows.length - height));
          const hints = navigation.map(action => `${action.id === 'previous' ? '←' : '→'} ${safe(action.label)}`).join(' · ');
          return [theme.fg('accent', theme.bold(safe(element.title))), '', ...rows.slice(offset, offset + height),
            truncateToWidth(`${hints ? `${hints} · ` : ''}↑↓/PgUp/PgDn scroll · Esc dismiss`, width)];
        },
        invalidate: () => body.invalidate(),
        handleInput(data) {
          if (matchesKey(data, Key.escape)) {
            const close = element.actions.find(action => action.id === 'close' && action.target === 'element' && action.outcome === 'cancel');
            done(close ? { elementId: element.id, revision: element.revision, actionId: close.id, outcome: close.outcome, values: {} } : undefined); return;
          }
          const id = matchesKey(data, Key.left) ? 'previous' : matchesKey(data, Key.right) ? 'next' : undefined;
          const action = navigation.find(value => value.id === id);
          if (action) { done({ elementId: element.id, revision: element.revision, actionId: action.id, outcome: action.outcome, values: {} }); return; }
          const height = Math.max(1, tui.terminal.rows - 6);
          if (matchesKey(data, Key.up)) offset--;
          else if (matchesKey(data, Key.down)) offset++;
          else if (matchesKey(data, Key.pageUp)) offset -= height;
          else if (matchesKey(data, Key.pageDown)) offset += height;
          else if (matchesKey(data, Key.home)) offset = 0;
          else if (matchesKey(data, Key.end)) offset = Number.MAX_SAFE_INTEGER;
          tui.requestRender();
        },
      };
    });
    return signal.aborted ? undefined : result;
  } finally { positions.set(element.id, offset); signal.removeEventListener('abort', abort); }
}
