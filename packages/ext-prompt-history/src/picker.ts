import type { Theme } from "@felan-ai/agent-core";
import {
	CURSOR_MARKER,
	Key,
	matchesKey,
	truncateToWidth,
	type Component,
	type Focusable,
} from "@earendil-works/pi-tui";
import type { PromptHistoryDisplayMode } from "./config.js";
import {
	PROMPT_HISTORY_SCOPES,
	searchPromptHistory,
	type PromptHistoryItem,
	type PromptHistoryScope,
	type PromptHistorySearchState,
	type PromptHistorySource,
} from "./history.js";

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
}

export class PromptHistoryPicker implements Component, Focusable {
	focused = false;
	private scope: PromptHistoryScope = "session";
	private query = "";
	private selectedIndex = 0;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;
	private searchToken = 0;
	private searchTimer: ReturnType<typeof setTimeout> | undefined;
	private closed = false;
	private readonly states: Record<PromptHistoryScope, PromptHistorySearchState>;

	constructor(
		private readonly source: PromptHistorySource,
		private readonly theme: Theme,
		private readonly requestRender: () => void,
		private readonly done: (value: PromptHistoryResult | undefined) => void,
		private readonly displayMode: PromptHistoryDisplayMode = "inline",
	) {
		this.states = {
			session: emptySearchState(true),
			project: emptySearchState(false),
			all: emptySearchState(false),
		};
		this.searchTimer = setTimeout(() => {
			this.searchTimer = undefined;
			if (!this.closed && this.searchToken === 0) this.scheduleSearch(0);
		}, 0);
	}

	handleInput(data: string): void {
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
			if (selected) this.finish({ text: selected.text });
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

	render(width: number): string[] {
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
			apply(await searchPromptHistory(this.source, scope, query, apply, current));
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
