import { createElementNavigation } from './navigation.js';
import { decodeUiMarkdown } from '../../client/ui.js';
import type { ExtensionContext, ThemeColor, UiActionRequest, UiPresentation } from "@felan-ai/agent-core";
import { Key, Markdown, matchesKey, stripTerminalSequences, truncateToWidth, type MarkdownTheme } from "@earendil-works/pi-tui";

const positions = createElementNavigation<number>();

export async function presentContextDocument(element: UiPresentation, ui: Pick<ExtensionContext['ui'], 'custom'>,
	signal: AbortSignal, displayMode: 'inline' | 'overlay' = 'inline'): Promise<UiActionRequest | undefined> {
	if (element.kind !== 'document') throw new Error('Expected a context report document.');
	const close = element.actions.find(action => action.id === 'close' && action.target === 'element' && action.outcome === 'cancel');
	if (!close) throw new Error('Context report is missing its close action.');
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
			
			if (signal.aborted) abort();
			return {
				render(width) {
					const height = Math.max(1, tui.terminal.rows - 6);
					const rows = body.render(width);
					offset = Math.max(0, Math.min(offset, rows.length - height));
					return [theme.fg('accent', theme.bold(safe(element.title))), '', ...rows.slice(offset, offset + height),
						truncateToWidth('↑↓ scroll · PgUp/PgDn page · Enter/Esc close', width)];
				},
				invalidate: () => body.invalidate(),
				handleInput(data) {
					if (matchesKey(data, Key.escape) || data === 'q' || matchesKey(data, Key.enter)) {
						done({ elementId: element.id, revision: element.revision, actionId: close.id, outcome: close.outcome, values: {} });
					} else {
						if (matchesKey(data, Key.up)) offset--;
						if (matchesKey(data, Key.down)) offset++;
						if (matchesKey(data, Key.pageUp)) offset -= Math.max(1, tui.terminal.rows - 6);
						if (matchesKey(data, Key.pageDown)) offset += Math.max(1, tui.terminal.rows - 6);
						if (matchesKey(data, Key.home)) offset = 0;
						if (matchesKey(data, Key.end)) offset = Number.MAX_SAFE_INTEGER;
						tui.requestRender();
					}
				},
			};
		}, displayMode === 'overlay' ? { overlay: true, overlayOptions: { width: '85%', minWidth: 72, maxHeight: '90%', margin: 2 } } : undefined);
		return signal.aborted ? undefined : result;
	} finally { positions.set(element.id, offset); signal.removeEventListener('abort', abort); }
}

