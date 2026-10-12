import { DynamicBorder, type Theme, type ThemeColor } from "@felan-ai/agent-core";
import { Container, Key, matchesKey, Spacer, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { ContextViewDisplayMode } from "./config.js";
import { USED_CATEGORIES, formatTokens, formatPercent, type CategoryKey, type ContextReport, type ContextViewPresentationHost } from "./report.js";

export function createTuiContextViewHost(): ContextViewPresentationHost {
	return {
		async show(ui, report, displayMode, signal) {
			if (signal.aborted) return;
			let finish: (() => void) | undefined;
			let closed = false;
			const abort = () => finish?.();
			signal.addEventListener("abort", abort, { once: true });
			try {
				await ui.custom<void>((_tui, theme, _keys, done) => {
					finish = () => { if (!closed) { closed = true; done(undefined); } };
					const component = new ContextUsageOverlay(report, theme, finish, displayMode);
					if (signal.aborted) finish();
					return component;
				}, displayMode === "overlay" ? { overlay: true, overlayOptions: { width: 88, minWidth: 56, maxHeight: "90%", margin: 2 } } : undefined);
			} finally { signal.removeEventListener("abort", abort); closed = true; }
		},
	};
}

export type { ContextViewPresentationHost } from "./report.js";

interface CategoryDefinition {
	key: CategoryKey;
	label: string;
	marker: string;
	color: ThemeColor;
}

const CATEGORY_DEFINITIONS: CategoryDefinition[] = [
	{ key: "systemPrompt", label: "System Prompt", marker: "⛁", color: "accent" },
	{ key: "systemTools", label: "System Tools", marker: "⛀", color: "warning" },
	{ key: "extensions", label: "Extensions", marker: "⛃", color: "success" },
	{ key: "contextFiles", label: "Context Files", marker: "⛬", color: "customMessageText" },
	{ key: "skills", label: "Skills", marker: "⛧", color: "thinkingHigh" },
	{ key: "memory", label: "Memory", marker: "⛜", color: "customMessageText" },
	{ key: "messages", label: "Messages", marker: "⛝", color: "text" },
	{ key: "other", label: "Other", marker: "◆", color: "muted" },
	{ key: "available", label: "Free Space", marker: "⛶", color: "dim" },
];

export class ContextUsageOverlay implements Component {
	constructor(
		private readonly report: ContextReport,
		private readonly theme: Theme,
		private readonly done: (result: void) => void,
		private readonly displayMode: ContextViewDisplayMode = "inline",
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || data === "q" || data === "Q") {
			this.done(undefined);
		}
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		const borderColor = (text: string) => this.theme.fg("border", text);
		const contentWidth = this.displayMode === "overlay" ? Math.max(1, renderWidth - 2) : renderWidth;
		const container = new Container();

		container.addChild(new DynamicBorder(borderColor));
		container.addChild(new Text(this.theme.fg("accent", this.theme.bold("Context Usage")), 1, 0));
		if (this.report.modelLabel) {
			container.addChild(new Text(this.theme.fg("dim", this.report.modelLabel), 1, 0));
		}
		container.addChild(new Spacer(1));

		for (const line of this.renderDiagramWithCategoryRows()) {
			container.addChild(new Text(line, 1, 0));
		}

		container.addChild(new Spacer(1));
		container.addChild(new Text(this.renderTotalLine(), 1, 0));
		container.addChild(new Text(this.renderCountsLine(), 1, 0));
		container.addChild(new Text(this.renderMemoryLine(), 1, 0));

		for (const line of this.renderExtensionRows()) {
			container.addChild(new Text(line, 1, 0));
		}

		for (const line of this.renderSkillRows()) {
			container.addChild(new Text(line, 1, 0));
		}

		container.addChild(new Spacer(1));
		container.addChild(new Text(this.theme.fg("dim", "Esc, Enter, or q to close"), 1, 0));
		container.addChild(new DynamicBorder(borderColor));

		const lines = container.render(contentWidth).map((line) => truncateToWidth(line, contentWidth, "", true));
		if (this.displayMode === "inline") return lines;
		return [
			borderColor(`╭${"─".repeat(Math.max(1, renderWidth - 2))}╮`),
			...lines.map((line) => `${borderColor("│")}${line}${borderColor("│")}`),
			borderColor(`╰${"─".repeat(Math.max(1, renderWidth - 2))}╯`),
		];
	}

	invalidate(): void {}

	private renderDiagramWithCategoryRows(): string[] {
		const grid = this.renderGrid();
		const categories = [this.theme.fg("dim", "Estimated usage by category"), ...this.renderCategoryRows()];
		const rows: string[] = [];
		const rowCount = Math.max(grid.length, categories.length);
		const blankGrid = " ".repeat(19);

		for (let index = 0; index < rowCount; index++) {
			const left = grid[index] ?? blankGrid;
			const right = categories[index] ?? "";
			rows.push(right ? `${left}   ${right}` : left);
		}

		return rows;
	}

	private renderGrid(): string[] {
		const cells = allocateGridCells(this.report);
		const lines: string[] = [];

		for (let row = 0; row < 5; row++) {
			const start = row * 10;
			const content = cells
				.slice(start, start + 10)
				.map((key) => this.colorCategory(key, CATEGORY_DEFINITIONS.find((definition) => definition.key === key)!.marker))
				.join(" ");
			lines.push(content);
		}

		return lines;
	}

	private renderTotalLine(): string {
		const estimated = this.report.estimated ? " estimated" : "";
		const total = this.report.contextWindow === null ? formatTokens(this.report.usedTokens) : `${formatTokens(this.report.usedTokens)} / ${formatTokens(this.report.contextWindow)}`;
		return `${this.theme.fg("accent", "Used")}: ${total} (${formatPercent(this.report.usagePercent)})${estimated}`;
	}

	private renderCountsLine(): string {
		return this.theme.fg(
			"dim",
			`${this.report.systemToolCount} system tool${this.report.systemToolCount === 1 ? "" : "s"} · ${this.report.extensionToolCount} extension tool${this.report.extensionToolCount === 1 ? "" : "s"} · ${this.report.contextFileCount} context file${this.report.contextFileCount === 1 ? "" : "s"} · ${this.report.skillCount} skill${this.report.skillCount === 1 ? "" : "s"}`,
		);
	}

	private renderMemoryLine(): string {
		return this.theme.fg("dim", `Memory: summary ${formatTokens(this.report.memory.summary)} · index ${formatTokens(this.report.memory.index)} · schema ${formatTokens(this.report.memory.schema)} · recalls ${formatTokens(this.report.memory.recalls)}`);
	}

	private renderCategoryRows(): string[] {
		const denominator = this.report.contextWindow ?? this.report.usedTokens;
		return CATEGORY_DEFINITIONS.map((definition) => {
			const tokens = this.report.breakdown[definition.key];
			const percent = denominator > 0 ? (tokens / denominator) * 100 : null;
			const marker = this.colorCategory(definition.key, definition.marker);
			return `${marker} ${definition.label.padEnd(14)} ${formatTokens(tokens).padStart(8)} ${formatPercent(percent).padStart(7)}`;
		});
	}

	private renderExtensionRows(): string[] {
		if (this.report.extensionDetails.length === 0) return [];

		const rows = ["", this.theme.fg("dim", "Extensions")];
		const visible = this.report.extensionDetails.slice(0, 8);
		for (const detail of visible) {
			rows.push(`  ${truncatePlain(detail.label, 28).padEnd(28)} ${this.theme.fg("dim", `${detail.toolCount} tool${detail.toolCount === 1 ? "" : "s"} · ${formatTokens(detail.tokens)} context`)}`);
		}
		const total = this.report.extensionDetailsTotal ?? this.report.extensionDetails.length;
		if (total > visible.length) {
			rows.push(this.theme.fg("dim", `  +${total - visible.length} more`));
		}
		return rows;
	}

	private renderSkillRows(): string[] {
		if (this.report.skillDetails.length === 0) return [];

		const rows = ["", this.theme.fg("dim", "Skills")];
		const visible = this.report.skillDetails.slice(0, 8);
		for (const detail of visible) {
			const tokens = detail.promptVisible ? `${formatTokens(detail.tokens)} context` : "not in prompt";
			rows.push(`  ${truncatePlain(detail.label, 28).padEnd(28)} ${this.theme.fg("dim", tokens)}`);
		}
		const total = this.report.skillDetailsTotal ?? this.report.skillDetails.length;
		if (total > visible.length) {
			rows.push(this.theme.fg("dim", `  +${total - visible.length} more`));
		}
		return rows;
	}

	private colorCategory(key: CategoryKey, text: string): string {
		const definition = CATEGORY_DEFINITIONS.find((item) => item.key === key)!;
		return this.theme.fg(definition.color, text);
	}
}

function allocateGridCells(report: ContextReport): CategoryKey[] {
	const total = report.contextWindow && report.contextWindow > 0 ? report.contextWindow : report.usedTokens;
	if (total <= 0) return Array(50).fill("available") as CategoryKey[];

	const categories = CATEGORY_DEFINITIONS.map((definition) => ({
		key: definition.key,
		tokens: report.contextWindow && report.contextWindow > 0 ? report.breakdown[definition.key] : definition.key === "available" ? 0 : report.breakdown[definition.key],
	}));
	const exact = categories.map((item) => ({ ...item, cells: (item.tokens / total) * 50 }));
	const counts = new Map<CategoryKey, number>();
	let assigned = 0;

	for (const item of exact) {
		const whole = Math.min(50, Math.max(0, Math.floor(item.cells)));
		counts.set(item.key, whole);
		assigned += whole;
	}

	const byRemainder = [...exact].sort((left, right) => right.cells % 1 - (left.cells % 1));
	for (let remaining = 50 - assigned, index = 0; remaining > 0; remaining--, index++) {
		const key = byRemainder[index % byRemainder.length]!.key;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}

	const cells: CategoryKey[] = [];
	for (const definition of CATEGORY_DEFINITIONS) {
		cells.push(...Array(counts.get(definition.key) ?? 0).fill(definition.key));
	}

	const visibleCells = cells.slice(0, 50);
	if (report.usedTokens > 0 && !visibleCells.some((key) => key !== "available")) {
		const largestUsed = [...USED_CATEGORIES].sort((left, right) => report.breakdown[right] - report.breakdown[left]).find((key) => report.breakdown[key] > 0);
		if (largestUsed) visibleCells[0] = largestUsed;
	}

	return visibleCells;
}

function truncatePlain(text: string, maxLength: number): string {
	return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}
