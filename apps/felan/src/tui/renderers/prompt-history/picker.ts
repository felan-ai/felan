import { decodeUiMarkdown } from '../../../client/ui.js';
import type { UiDocument, UiView } from "@felan-ai/session-protocol";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@felan-ai/agent-core";
import {
	CURSOR_MARKER,
	Key,
	matchesKey,
	truncateToWidth,
	type Component,
	type Focusable,
} from "@earendil-works/pi-tui";
import type { PromptHistoryDisplayMode } from "@felan-ai/ext-prompt-history/data";
import {
	PROMPT_HISTORY_SCOPES,
	type PromptHistoryItem,
	type PromptHistoryScope,
	type PromptHistorySearchState,
	type PromptHistorySearch,
} from "@felan-ai/ext-prompt-history/data";

export const PROMPT_HISTORY_SHORTCUT = Key.ctrl("r");
export const PROMPT_HISTORY_COMMAND_SHORTCUT = Key.super("r");
export const PROMPT_HISTORY_SCOPE_SHORTCUT = Key.ctrl("s");
export const MAX_VISIBLE_PROMPT_HISTORY_ITEMS = 12;
export const PROMPT_HISTORY_SEARCH_DEBOUNCE_MS = 120;

const SCOPE_LABELS: Record<PromptHistoryScope, string> = {
	all: "All projects",
	project: "Current project",
	session: "Current session",
};

export interface PromptHistoryResult {
	readonly text: string;
	readonly id: string;
}
export interface PromptHistoryNavigation { scope: PromptHistoryScope; query: string; selectedIndex: number; selectedId?: string }

export class PromptHistoryPicker implements Component, Focusable {
	focused = false;
	private scope: PromptHistoryScope = "session";
	private query = "";
	private selectedIndex = 0;
	private elementLineCount = 0;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;
	private searchToken = 0;
	private searchTimer: ReturnType<typeof setTimeout> | undefined;
	private closed = false;
	private readonly states: Record<PromptHistoryScope, PromptHistorySearchState>;

	constructor(
		private readonly search: PromptHistorySearch | undefined,
		private readonly theme: Theme,
		private readonly requestRender: () => void,
		private readonly done: (value: PromptHistoryResult | undefined) => void,
		private readonly displayMode: PromptHistoryDisplayMode = "inline",
		navigation?: PromptHistoryNavigation,
		private readonly element?: { source: UiView | UiDocument; action(id?: string, itemId?: string): void; use?(): void; search?(query: string, scope: PromptHistoryScope): void },
	) {
		if (navigation) { this.scope = navigation.scope; this.query = navigation.query; this.selectedIndex = navigation.selectedIndex; }
		this.states = {
			session: emptySearchState(true),
			project: emptySearchState(false),
			all: emptySearchState(false),
		};
		if (element) {
      if (element.source.kind === "view") {
        this.selectedIndex = Math.max(0, element.source.items.findIndex(item => item.id === navigation?.selectedId));
        const values = element.source.query?.values;
        if (typeof values?.query === "string") this.query = values.query;
        if (PROMPT_HISTORY_SCOPES.includes(values?.scope as PromptHistoryScope)) this.scope = values!.scope as PromptHistoryScope;
      }
      return;
    }
		if (!search) throw new Error("Prompt search is required.");
		this.searchTimer = setTimeout(() => {
			this.searchTimer = undefined;
			if (!this.closed && this.searchToken === 0) this.scheduleSearch(0);
		}, 0);
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (this.element) { this.handleElementInput(data); return; }
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.finish(undefined);
			return;
		}
		if (
			matchesKey(data, PROMPT_HISTORY_SHORTCUT)
			|| matchesKey(data, PROMPT_HISTORY_COMMAND_SHORTCUT)
			|| matchesKey(data, PROMPT_HISTORY_SCOPE_SHORTCUT)
		) {
			this.cycleScope();
			return;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
			const selected = this.filteredItems()[this.selectedIndex];
			if (selected) this.finish({ text: selected.text, id: selected.id });
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) {
			this.moveSelection(-1);
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) {
			this.moveSelection(1);
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.moveSelection(-MAX_VISIBLE_PROMPT_HISTORY_ITEMS);
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.moveSelection(MAX_VISIBLE_PROMPT_HISTORY_ITEMS);
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			if (this.query.length > 0) {
				this.query = Array.from(this.query).slice(0, -1).join("");
				this.resetSelectionAndSearch();
			}
			return;
		}
		if (matchesKey(data, Key.delete)) {
			this.query = "";
			this.resetSelectionAndSearch();
			return;
		}
		if (Array.from(data).length === 1 && (data.codePointAt(0) ?? 0) >= 32) {
			this.query += data;
			this.resetSelectionAndSearch();
		}
	}

	private handleElementInput(data: string): void {
		const { source, action } = this.element!;
		if (source.kind === "document" && (matchesKey(data, Key.enter) || data === "u")) { this.element!.use?.(); return; }
		const shortcuts: Record<string, string> = { "[": "previous", "]": "next" };
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.done(undefined); return; }
		const id = shortcuts[data];
		if (source.kind === "view" && (matchesKey(data, Key.ctrl("s")) || matchesKey(data, Key.ctrl("r")) || matchesKey(data, Key.super("r")))) {
      if (!source.actions.find(entry => entry.id === "search")?.input?.fields.some(field => field.id === "scope")) { action("search"); return; }
      const scope = PROMPT_HISTORY_SCOPES[(PROMPT_HISTORY_SCOPES.indexOf(this.scope) + 1) % PROMPT_HISTORY_SCOPES.length]!;
      this.element!.search?.(this.query, scope); return;
    }
    if (matchesKey(data, Key.alt("a"))) { action(); return; }
    if (source.kind === "view" && (matchesKey(data, Key.backspace) || Array.from(data).length === 1 && (data.codePointAt(0) ?? 0) >= 32)) {
      this.query = matchesKey(data, Key.backspace) ? Array.from(this.query).slice(0, -1).join("") : this.query + data;
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.element!.search?.(this.query, this.scope), PROMPT_HISTORY_SEARCH_DEBOUNCE_MS);
      this.requestRender(); return;
    }
		if (id && source.actions.some(entry => entry.id === id)) { action(id); return; }
		if (source.kind === "document") {
			if (matchesKey(data, Key.left) || matchesKey(data, Key.backspace)) { action("back"); return; }
			const count = this.elementLineCount;
			this.selectedIndex = Math.max(0, Math.min(this.selectedIndex + (matchesKey(data, Key.up) ? -1 : matchesKey(data, Key.down) ? 1 : 0), count - 24));
		} else {
			this.selectedIndex = Math.max(0, Math.min(this.selectedIndex + (matchesKey(data, Key.up) ? -1 : matchesKey(data, Key.down) ? 1 : 0), source.items.length - 1));
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
				const item = source.items[this.selectedIndex];
				if (item) action("detail", item.id);
				return;
			}
		}
		this.requestRender();
	}
	private renderElement(width: number): string[] {
		const source = this.element!.source;
		const clean = (text: string) => stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "");
		const lines = [this.theme.fg("accent", this.theme.bold(clean(source.title))),
			source.kind === "view" ? `Search: ${clean(this.query)} · ↑↓ navigate · enter use · Ctrl+R scope · Alt+A actions · Esc close` : "↑↓ scroll · enter use full prompt · ← results · [/] pages · Esc dismiss"];
		if (source.kind === "document") {
			const content = clean(decodeUiMarkdown(source.markdown, { plainText: true })).split("\n");
			this.elementLineCount = content.length;
			lines.push(...content.slice(this.selectedIndex, this.selectedIndex + 24));
		}
		else for (const [index, item] of source.items.slice(this.visibleStart(source.items.length), this.visibleStart(source.items.length) + MAX_VISIBLE_PROMPT_HISTORY_ITEMS).entries()) {
			const selected = this.visibleStart(source.items.length) + index === this.selectedIndex;
			const preview = clean(`${selected ? "›" : " "} ${item.values.preview}${item.values.clipped ? "…" : ""}`);
			lines.push(selected ? this.theme.fg("accent", this.theme.bold(preview)) : preview,
				this.theme.fg("dim", clean(`  ${item.values.project} · ${item.values.session} · ${new Date(Number(item.values.timestamp)).toLocaleString()}`)));
		}
		return frameLines(lines.map(line => truncateToWidth(line, Math.max(1, width - 2), "…")), width, this.displayMode, this.theme);
	}

	render(width: number): string[] {
		if (this.element) return this.renderElement(Math.max(1, Math.floor(width)));
		const renderWidth = Math.max(1, Math.floor(width));
		if (this.cachedLines && this.cachedWidth === renderWidth) return this.cachedLines;

		const th = this.theme;
		const filtered = this.filteredItems();
		const state = this.states[this.scope];
		const lines: string[] = [];
		const frameContentWidth = this.displayMode === "overlay"
			? Math.max(1, renderWidth - 2)
			: renderWidth;
		const itemContentWidth = Math.max(1, frameContentWidth - 4);
		const cursor = this.focused ? CURSOR_MARKER + th.fg("accent", "▌") : "";

		lines.push(truncateToWidth(
			` ${th.fg("accent", th.bold("Prompt History"))} ${th.fg("muted", "·")} ${SCOPE_LABELS[this.scope]} ${th.fg("dim", formatCount(state))}`,
			frameContentWidth,
		));
		lines.push(truncateToWidth(` ${th.fg("muted", "Search:")} ${this.query}${cursor}`, frameContentWidth));
		lines.push("");

		const start = this.visibleStart(filtered.length);
		const visible = filtered.slice(start, start + MAX_VISIBLE_PROMPT_HISTORY_ITEMS);
		const emptyMessage = state.loading
			? th.fg("muted", "Searching prompt history…")
			: th.fg("warning", "No matching prompts");

		for (let index = 0; index < MAX_VISIBLE_PROMPT_HISTORY_ITEMS; index++) {
			const item = visible[index];
			if (item) {
				const selected = start + index === this.selectedIndex;
				const marker = selected ? th.fg("accent", "›") : " ";
				const preview = highlightMatches(formatPreview(item.text), this.query, th);
				const promptLine = selected && !this.query.trim() ? th.bold(preview) : preview;
				lines.push(truncateToWidth(` ${marker} ${promptLine}`, frameContentWidth));
				lines.push(truncateToWidth(`   ${th.fg("dim", formatMetadata(item))}`, itemContentWidth));
			} else if (index === 0) {
				lines.push(truncateToWidth(`   ${emptyMessage}`, frameContentWidth));
				lines.push("");
			} else {
				lines.push("", "");
			}
		}

		lines.push(truncateToWidth(`  ${th.fg("dim", formatStatus(state, filtered.length, start))}`, frameContentWidth));
		lines.push("");
		lines.push(truncateToWidth(
			` ${th.fg("dim", "↑/↓ move · Enter select · Cmd/Ctrl+R scope · Esc cancel")}`,
			frameContentWidth,
		));

		this.cachedWidth = renderWidth;
		this.cachedLines = frameLines(lines, renderWidth, this.displayMode, th);
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	dispose(): void {
		this.close();
	}

	getNavigation(): PromptHistoryNavigation {
		return { scope: this.scope, query: this.query, selectedIndex: this.selectedIndex,
			...(this.element?.source.kind === "view" && this.element.source.items[this.selectedIndex] ? { selectedId: this.element.source.items[this.selectedIndex]!.id } : {}) };
	}

	private filteredItems(): readonly PromptHistoryItem[] {
		return this.states[this.scope].items;
	}

	private cycleScope(): void {
		const currentIndex = PROMPT_HISTORY_SCOPES.indexOf(this.scope);
		this.scope = PROMPT_HISTORY_SCOPES[(currentIndex + 1) % PROMPT_HISTORY_SCOPES.length] ?? "session";
		this.resetSelectionAndSearch(0);
	}

	private moveSelection(delta: number): void {
		const count = this.filteredItems().length;
		if (count === 0) return;
		this.selectedIndex = Math.max(0, Math.min(count - 1, this.selectedIndex + delta));
		this.invalidate();
		this.requestRender();
	}

	private resetSelectionAndSearch(delayMs = PROMPT_HISTORY_SEARCH_DEBOUNCE_MS): void {
		this.selectedIndex = 0;
		this.scheduleSearch(delayMs);
	}

	private scheduleSearch(delayMs: number): void {
		this.invalidate();
		this.requestRender();
		if (this.searchTimer) clearTimeout(this.searchTimer);
		this.searchTimer = undefined;
		if (this.scope === "session") {
			this.searchToken++;
			this.states.session = emptySearchState(true);
			void this.runSearch(this.searchToken, "session", this.query);
			return;
		}

		const token = ++this.searchToken;
		const scope = this.scope;
		const query = this.query;
		this.states[scope] = emptySearchState(true);
		this.searchTimer = setTimeout(() => {
			this.searchTimer = undefined;
			void this.runSearch(token, scope, query);
		}, delayMs);
	}

	private async runSearch(
		token: number,
		scope: PromptHistoryScope,
		query: string,
	): Promise<void> {
		const current = () => !this.closed
			&& token === this.searchToken
			&& scope === this.scope
			&& query === this.query;
		const apply = (state: PromptHistorySearchState) => {
			if (!current()) return;
			this.states[scope] = state;
			this.clampSelection();
			this.invalidate();
			this.requestRender();
		};

		try {
			apply(await this.search!(scope, query, apply, current));
		} catch {
			apply(emptySearchState(false, true));
		}
	}

	private clampSelection(): void {
		const count = this.filteredItems().length;
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, count - 1)));
	}

	private finish(value: PromptHistoryResult | undefined): void {
		if (this.closed) return;
		this.close();
		this.done(value);
	}

	private close(): void {
		this.closed = true;
		this.searchToken++;
		if (this.searchTimer) clearTimeout(this.searchTimer);
		this.searchTimer = undefined;
	}

	private visibleStart(count: number): number {
		return Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(MAX_VISIBLE_PROMPT_HISTORY_ITEMS / 2),
				count - MAX_VISIBLE_PROMPT_HISTORY_ITEMS,
			),
		);
	}
}

function frameLines(
	lines: readonly string[],
	width: number,
	displayMode: PromptHistoryDisplayMode,
	theme: Theme,
): string[] {
	const border = (text: string) => theme.fg("borderMuted", text);
	if (displayMode === "inline") {
		return [border("─".repeat(width)), ...lines, border("─".repeat(width))];
	}

	const innerWidth = Math.max(1, width - 2);
	const fit = (line: string) => truncateToWidth(line, innerWidth, "", true);
	return [
		border(`╭${"─".repeat(innerWidth)}╮`),
		...lines.map((line) => `${border("│")}${fit(line)}${border("│")}`),
		border(`╰${"─".repeat(innerWidth)}╯`),
	];
}

function emptySearchState(loading: boolean, complete = false): PromptHistorySearchState {
	return { items: [], loading, scanned: 0, complete };
}

function formatPreview(text: string): string {
	return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function formatCount(state: PromptHistorySearchState): string {
	if (state.total === undefined) return `(${state.items.length})`;
	return `(${state.items.length}${state.complete ? "" : "+"}, scanned ${state.scanned}/${state.total})`;
}

function formatStatus(
	state: PromptHistorySearchState,
	count: number,
	start: number,
): string {
	if (count === 0) return state.loading ? "Searching…" : "No matches";
	const range = `Showing ${start + 1}-${Math.min(start + MAX_VISIBLE_PROMPT_HISTORY_ITEMS, count)} of ${count}`;
	return state.loading ? `${range} · searching more…` : range;
}

function highlightMatches(text: string, query: string, theme: Theme): string {
	const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return text;

	const chars = Array.from(text);
	const lowerChars = chars.map((char) => char.toLocaleLowerCase());
	const highlighted = new Set<number>();
	for (const token of tokens) markTokenMatches(lowerChars, Array.from(token), highlighted);

	let result = "";
	let run = "";
	let runHighlighted = highlighted.has(0);
	for (let index = 0; index < chars.length; index++) {
		const currentHighlighted = highlighted.has(index);
		if (currentHighlighted !== runHighlighted) {
			result += styleHighlightRun(run, runHighlighted, theme);
			run = "";
			runHighlighted = currentHighlighted;
		}
		run += chars[index];
	}
	return result + styleHighlightRun(run, runHighlighted, theme);
}

function markTokenMatches(
	lowerChars: readonly string[],
	token: readonly string[],
	highlighted: Set<number>,
): void {
	if (token.length === 0) return;
	for (let start = 0; start <= lowerChars.length - token.length; start++) {
		let matches = true;
		for (let offset = 0; offset < token.length; offset++) {
			if (lowerChars[start + offset] !== token[offset]) {
				matches = false;
				break;
			}
		}
		if (!matches) continue;
		for (let offset = 0; offset < token.length; offset++) highlighted.add(start + offset);
		return;
	}

	const positions: number[] = [];
	let searchFrom = 0;
	for (const char of token) {
		const index = lowerChars.findIndex((candidate, candidateIndex) => (
			candidateIndex >= searchFrom && candidate === char
		));
		if (index === -1) return;
		positions.push(index);
		searchFrom = index + 1;
	}
	for (const position of positions) highlighted.add(position);
}

function styleHighlightRun(text: string, highlighted: boolean, theme: Theme): string {
	return highlighted ? theme.fg("accent", theme.bold(text)) : text;
}

function formatMetadata(item: PromptHistoryItem): string {
	const project = item.cwd ? item.cwd.split(/[\\/]/u).filter(Boolean).at(-1) ?? item.cwd : "unknown project";
	const session = item.sessionName?.trim() || item.sessionLabel;
	return `${project} · ${session} · ${new Date(item.timestamp).toLocaleString()}`;
}

