export type UsedCategoryKey = "systemPrompt" | "systemTools" | "extensions" | "contextFiles" | "skills" | "memory" | "messages" | "other";
export type CategoryKey = UsedCategoryKey | "available";

export type UsedEstimates = Record<UsedCategoryKey, number>;
export type TokenBreakdown = Record<CategoryKey, number>;

export interface ExtensionDetail {
	label: string;
	toolCount: number;
	tokens: number;
}

export interface SkillDetail {
	label: string;
	tokens: number;
	promptVisible: boolean;
}

export interface MemoryBreakdown {
	summary: number;
	index: number;
	schema: number;
	recalls: number;
}

export interface ContextReport {
	breakdown: TokenBreakdown;
	usedTokens: number;
	contextWindow: number | null;
	usagePercent: number | null;
	estimated: boolean;
	systemToolCount: number;
	extensionToolCount: number;
	contextFileCount: number;
	skillCount: number;
	memory: MemoryBreakdown;
	extensionDetails: ExtensionDetail[];
	skillDetails: SkillDetail[];
	extensionDetailsTotal?: number;
	skillDetailsTotal?: number;
	modelLabel: string | null;
}

export const USED_CATEGORIES: UsedCategoryKey[] = ["systemPrompt", "systemTools", "extensions", "contextFiles", "skills", "memory", "messages", "other"];
export const CATEGORY_SUMMARIES: ReadonlyArray<{ key: CategoryKey; label: string }> = [
	{ key: "systemPrompt", label: "System Prompt" },
	{ key: "systemTools", label: "System Tools" },
	{ key: "extensions", label: "Extensions" },
	{ key: "contextFiles", label: "Context Files" },
	{ key: "skills", label: "Skills" },
	{ key: "memory", label: "Memory" },
	{ key: "messages", label: "Messages" },
	{ key: "other", label: "Other" },
	{ key: "available", label: "Free Space" },
];

export interface ContextViewPresentationHost {
	show(report: ContextReport, signal: AbortSignal): Promise<void>;
}

export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${trimFixed(tokens / 1_000_000)}M`;
	if (tokens >= 1_000) return `${trimFixed(tokens / 1_000)}k`;
	return Math.round(tokens).toString();
}

function trimFixed(value: number): string {
	return value.toFixed(1).replace(/\.0$/, "");
}

export function formatPercent(percent: number | null): string {
	if (percent === null || !Number.isFinite(percent)) return "n/a";
	if (percent > 0 && percent < 0.1) return "<0.1%";
	return `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
}
