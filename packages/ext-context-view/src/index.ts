import {
	associateExtensionConfig,
	DynamicBorder,
	formatSkillsForPrompt,
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type FelanExtension,
	type FelanExtensionAPI,
	type SessionEntry,
	type SessionMessageEntry,
	type Skill,
	type SlashCommandInfo,
	type SourceInfo,
	type Theme,
	type ThemeColor,
	type ToolInfo,
} from "@felan-ai/agent-core";
import { Container, Key, matchesKey, Spacer, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import {
	CONTEXT_VIEW_CONFIG,
	DEFAULT_CONTEXT_VIEW_DISPLAY_MODE,
	type ContextViewDisplayMode,
} from "./config.js";

export {
	CONTEXT_VIEW_CONFIG,
	CONTEXT_VIEW_DISPLAY_MODES,
	DEFAULT_CONTEXT_VIEW_DISPLAY_MODE,
} from "./config.js";
export type { ContextViewDisplayMode } from "./config.js";

type UsedCategoryKey = "systemPrompt" | "systemTools" | "extensions" | "contextFiles" | "skills" | "memory" | "messages" | "other";
type CategoryKey = UsedCategoryKey | "available";

type UsedEstimates = Record<UsedCategoryKey, number>;
type TokenBreakdown = Record<CategoryKey, number>;

interface CategoryDefinition {
	key: CategoryKey;
	label: string;
	marker: string;
	color: ThemeColor;
}

interface ExtensionDetail {
	label: string;
	toolCount: number;
	tokens: number;
}

interface SkillDetail {
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
	modelLabel: string | null;
}

interface TextPart {
	type: "text";
	text: string;
}

interface ThinkingPart {
	type: "thinking";
	thinking: string;
}

interface ToolCallPart {
	type: "toolCall";
	id: string;
	name: string;
	arguments: unknown;
}

interface PromptSectionEstimates {
	systemPrompt: number;
	contextFiles: number;
	skills: number;
	contextFileCount: number;
	skillCount: number;
	skillDetails: SkillDetail[];
}

interface ToolEstimates {
	systemTools: number;
	extensions: number;
	systemToolCount: number;
	extensionToolCount: number;
	extensionDetails: ExtensionDetail[];
}

	const USED_CATEGORIES: UsedCategoryKey[] = ["systemPrompt", "systemTools", "extensions", "contextFiles", "skills", "memory", "messages", "other"];
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

const contextViewExtension: FelanExtension = (pi) => {
	let latestPromptOptions: BuildSystemPromptOptions | undefined;
	let latestSystemPrompt: string | undefined;
	const displayMode = resolveDisplayMode(pi.config.displayMode);

	pi.on("before_agent_start", (event) => {
		latestPromptOptions = event.systemPromptOptions;
		latestSystemPrompt = event.systemPrompt;
	});

	pi.registerCommand("context", {
		description: "Show current context window usage",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const report = collectContextReport(pi, ctx, latestPromptOptions ?? ctx.getSystemPromptOptions(), latestSystemPrompt);

			if (!ctx.hasUI) {
				ctx.ui.notify(formatCompactReport(report), "info");
				return;
			}

			await ctx.ui.custom<void>(
				(_tui, theme, _keybindings, done) => new ContextUsageOverlay(report, theme, done, displayMode),
				displayMode === "overlay"
					? {
						overlay: true,
						overlayOptions: {
							width: 88,
							minWidth: 56,
							maxHeight: "90%",
							margin: 2,
						},
					}
					: undefined,
			);
		},
	});
};

associateExtensionConfig(contextViewExtension, CONTEXT_VIEW_CONFIG);
export default contextViewExtension;

function resolveDisplayMode(value: unknown): ContextViewDisplayMode {
	return value === "overlay" ? "overlay" : DEFAULT_CONTEXT_VIEW_DISPLAY_MODE;
}

export function collectContextReport(pi: ExtensionAPI | FelanExtensionAPI, ctx: ExtensionCommandContext, promptOptions: BuildSystemPromptOptions | undefined, latestSystemPrompt: string | undefined): ContextReport {
	const usage = ctx.getContextUsage();
	const branch = ctx.sessionManager.getBranch();
	const currentSystemPrompt = ctx.getSystemPrompt();
	const systemPrompt = currentSystemPrompt.length > 0 ? currentSystemPrompt : latestSystemPrompt ?? "";
	const activeToolNames = new Set(pi.getActiveTools());
	const activeTools = pi.getAllTools().filter((tool) => activeToolNames.has(tool.name));
	const commands = pi.getCommands();
	const promptSections = estimatePromptSections(systemPrompt, promptOptions, commands);
	const toolEstimates = estimateTools(activeTools);

	const estimates: UsedEstimates = {
		systemPrompt: promptSections.systemPrompt,
		systemTools: toolEstimates.systemTools,
		extensions: toolEstimates.extensions,
		contextFiles: promptSections.contextFiles,
		skills: promptSections.skills,
		memory: 0,
		messages: 0,
		other: 0,
	};
	const memory = { summary: 0, index: 0, schema: 0, recalls: 0 } satisfies MemoryBreakdown;
	const memoryToolCallIds = findMemoryToolCallIds(branch);

	for (const entry of getContextEntries(branch)) {
		addEntryEstimate(entry, estimates, memory, memoryToolCallIds);
	}

	const usedBreakdown = roundEstimates(estimates);
	const usedTokens = sumUsed(usedBreakdown);
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? null;
	const available = contextWindow === null ? 0 : Math.max(0, contextWindow - usedTokens);
	const usagePercent = contextWindow && contextWindow > 0 ? (usedTokens / contextWindow) * 100 : null;

	return {
		breakdown: {
			...usedBreakdown,
			available,
		},
		usedTokens,
		contextWindow,
		usagePercent,
		estimated: true,
		systemToolCount: toolEstimates.systemToolCount,
		extensionToolCount: toolEstimates.extensionToolCount,
		contextFileCount: promptSections.contextFileCount,
		skillCount: promptSections.skillCount,
		memory,
		extensionDetails: toolEstimates.extensionDetails,
		skillDetails: promptSections.skillDetails,
		modelLabel: formatModelLabel(ctx),
	};
}

function estimatePromptSections(systemPrompt: string, promptOptions: BuildSystemPromptOptions | undefined, commands: SlashCommandInfo[]): PromptSectionEstimates {
	const totalSystemPrompt = estimateTokens(systemPrompt);
	const contextFileSection = extractProjectContextSection(systemPrompt);
	const skillSection = extractDelimitedSection(systemPrompt, "<available_skills>", "</available_skills>");
	const contextFileTokens = estimateTokens(contextFileSection);
	const skillTokens = estimateTokens(skillSection);
	const skillCommands = commands.filter((command) => command.source === "skill");

	return {
		systemPrompt: Math.max(0, totalSystemPrompt - contextFileTokens - skillTokens),
		contextFiles: contextFileTokens,
		skills: skillTokens,
		contextFileCount: promptOptions?.contextFiles?.length ?? countContextFileHeadings(contextFileSection),
		skillCount: promptOptions?.skills?.length ?? skillCommands.length,
		skillDetails: promptOptions?.skills ? promptOptions.skills.map((skill) => estimateSkillDetail(skill, skillSection.length > 0)) : estimateSkillCommandDetails(skillCommands, skillSection.length > 0),
	};
}

function estimateSkillCommandDetails(commands: SlashCommandInfo[], promptVisible: boolean): SkillDetail[] {
	return commands.map((command) => ({
		label: command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name,
		tokens: promptVisible ? estimateTokens(`${command.name}\n${command.description ?? ""}`) : 0,
		promptVisible,
	}));
}

function estimateSkillDetail(skill: Skill, hasSkillSection: boolean): SkillDetail {
	const promptVisible = hasSkillSection && !skill.disableModelInvocation;
	return {
		label: skill.name,
		tokens: promptVisible ? estimateTokens(formatSkillsForPrompt([skill])) : 0,
		promptVisible,
	};
}

function estimateTools(activeTools: ToolInfo[]): ToolEstimates {
	let systemTools = 0;
	let extensions = 0;
	let systemToolCount = 0;
	let extensionToolCount = 0;
	const extensionDetails = new Map<string, ExtensionDetail>();

	for (const tool of activeTools) {
		const tokens = estimateToolDefinition(tool);
		if (isBuiltinTool(tool)) {
			systemTools += tokens;
			systemToolCount++;
			continue;
		}

		extensions += tokens;
		extensionToolCount++;
		const label = sourceLabel(tool.sourceInfo);
		const detail = extensionDetails.get(label) ?? { label, toolCount: 0, tokens: 0 };
		detail.toolCount++;
		detail.tokens += tokens;
		extensionDetails.set(label, detail);
	}

	return {
		systemTools,
		extensions,
		systemToolCount,
		extensionToolCount,
		extensionDetails: Array.from(extensionDetails.values()).sort((left, right) => right.tokens - left.tokens || left.label.localeCompare(right.label)),
	};
}

function estimateToolDefinition(tool: ToolInfo): number {
	return estimateTokens(
		safeStringify({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		}),
	);
}

function isBuiltinTool(tool: ToolInfo): boolean {
	return tool.sourceInfo.source === "builtin"
		|| tool.sourceInfo.path.startsWith("<builtin:")
		|| tool.sourceInfo.path === "<inline:@felan-ai/agent-core/runtime-tools>";
}

function sourceLabel(sourceInfo: SourceInfo): string {
	if (sourceInfo.source === "builtin") return "Built-in";
	if (sourceInfo.source === "sdk") return "SDK";
	if (sourceInfo.path.startsWith("<inline:") && sourceInfo.path.endsWith(">")) {
		return sourceInfo.path.slice("<inline:".length, -1);
	}
	if (sourceInfo.source && sourceInfo.source !== "local") return compactSource(sourceInfo.source);

	const normalized = (sourceInfo.baseDir ?? sourceInfo.path).replace(/\\/g, "/");
	const packagesMatch = normalized.match(/(?:^|\/)packages\/([^/]+)/);
	if (packagesMatch?.[1]) return packagesMatch[1];

	const extensionsMatch = normalized.match(/(?:^|\/)extensions\/([^/]+)/);
	if (extensionsMatch?.[1]) return stripScriptExtension(extensionsMatch[1]);

	const withoutEntry = normalized.replace(/\/src\/index\.[cm]?[tj]s$/, "").replace(/\/index\.[cm]?[tj]s$/, "").replace(/\.[cm]?[tj]s$/, "");
	return basename(withoutEntry) || compactSource(sourceInfo.path);
}

function compactSource(source: string): string {
	const normalized = source.replace(/\\/g, "/");
	if (normalized.startsWith("<inline:") && normalized.endsWith(">")) return normalized.slice("<inline:".length, -1);
	if (normalized.startsWith("<") && normalized.endsWith(">")) return normalized.slice(1, -1);
	return stripScriptExtension(basename(normalized)) || source;
}

function basename(path: string): string {
	return path.split("/").filter(Boolean).at(-1) ?? path;
}

function stripScriptExtension(path: string): string {
	return path.replace(/\.[cm]?[tj]s$/, "");
}

function getContextEntries(branch: SessionEntry[]): SessionEntry[] {
	const compactionIndex = findLastIndex(branch, (entry) => entry.type === "compaction");
	if (compactionIndex === -1) return branch.filter(isContextEntry);

	const compaction = branch[compactionIndex];
	if (!compaction || compaction.type !== "compaction") return branch.filter(isContextEntry);

	const entries: SessionEntry[] = [compaction];
	let foundFirstKept = false;

	for (let index = 0; index < compactionIndex; index++) {
		const entry = branch[index];
		if (!entry) continue;
		if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
		if (foundFirstKept && isContextEntry(entry)) entries.push(entry);
	}

	for (let index = compactionIndex + 1; index < branch.length; index++) {
		const entry = branch[index];
		if (entry && isContextEntry(entry)) entries.push(entry);
	}

	return entries;
}

function isContextEntry(entry: SessionEntry): boolean {
	return entry.type === "message" || entry.type === "branch_summary" || entry.type === "compaction" || entry.type === "custom_message";
}

function addEntryEstimate(entry: SessionEntry, estimates: UsedEstimates, memory: MemoryBreakdown, memoryToolCallIds: ReadonlySet<string>): void {
	switch (entry.type) {
		case "message":
			addMessageEstimate(entry.message, estimates, memory, memoryToolCallIds);
			return;
		case "custom_message":
			if (entry.customType === "felan-memory-context") {
				addInitialMemoryEstimate(entry.content, estimates, memory);
				return;
			}
			estimates.messages += estimateTextContent(entry.content);
			return;
		case "branch_summary":
			estimates.other += estimateTokens(entry.summary);
			return;
		case "compaction":
			estimates.other += estimateTokens(entry.summary);
			return;
	}
}

function addMessageEstimate(message: SessionMessageEntry["message"], estimates: UsedEstimates, memory: MemoryBreakdown, memoryToolCallIds: ReadonlySet<string>): void {
	switch (message.role) {
		case "user":
			estimates.messages += estimateTextContent(message.content);
			return;
		case "assistant":
			for (const part of message.content) {
				if (isTextPart(part)) {
					estimates.messages += estimateTokens(part.text);
				} else if (isThinkingPart(part)) {
					estimates.messages += estimateTokens(part.thinking);
				} else if (isToolCallPart(part)) {
					const tokens = estimateTokens(safeStringify({ name: part.name, arguments: part.arguments }));
					if (memoryToolCallIds.has(part.id)) {
						estimates.memory += tokens;
						memory.recalls += tokens;
					} else {
						estimates.messages += tokens;
					}
				} else {
					estimates.other += estimateTokens(safeStringify(part));
				}
			}
			return;
		case "toolResult":
			const tokens = estimateTextContent(message.content);
			if (memoryToolCallIds.has(message.toolCallId)) {
				estimates.memory += tokens;
				memory.recalls += tokens;
			} else {
				estimates.messages += tokens;
			}
			return;
		case "bashExecution":
			if (!message.excludeFromContext) {
				estimates.messages += estimateTokens(`${message.command}\n${message.output}`);
			}
			return;
		case "custom":
			estimates.messages += estimateTextContent(message.content);
			return;
		case "branchSummary":
			estimates.other += estimateTokens(message.summary);
			return;
		case "compactionSummary":
			estimates.other += estimateTokens(message.summary);
			return;
		default:
			estimates.other += estimateTokens(safeStringify(message));
	}
}

function estimateTextContent(content: unknown): number {
	if (typeof content === "string") return estimateTokens(content);
	if (!Array.isArray(content)) return 0;

	let tokens = 0;
	for (const part of content) {
		if (isTextPart(part)) tokens += estimateTokens(part.text);
	}
	return tokens;
}

function estimateTokens(text: string): number {
	return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

function roundEstimates(estimates: UsedEstimates): Record<UsedCategoryKey, number> {
	return {
		systemPrompt: Math.max(0, Math.round(estimates.systemPrompt)),
		systemTools: Math.max(0, Math.round(estimates.systemTools)),
		extensions: Math.max(0, Math.round(estimates.extensions)),
		contextFiles: Math.max(0, Math.round(estimates.contextFiles)),
		skills: Math.max(0, Math.round(estimates.skills)),
		memory: Math.max(0, Math.round(estimates.memory)),
		messages: Math.max(0, Math.round(estimates.messages)),
		other: Math.max(0, Math.round(estimates.other)),
	};
}

function sumUsed(breakdown: Record<UsedCategoryKey, number>): number {
	return USED_CATEGORIES.reduce((total, key) => total + breakdown[key], 0);
}

function isTextPart(value: unknown): value is TextPart {
	return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isThinkingPart(value: unknown): value is ThinkingPart {
	return isRecord(value) && value.type === "thinking" && typeof value.thinking === "string";
}

function isToolCallPart(value: unknown): value is ToolCallPart {
	return isRecord(value) && value.type === "toolCall" && typeof value.id === "string" && typeof value.name === "string" && "arguments" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function safeStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	try {
		return (
			JSON.stringify(
				value,
				(_key, innerValue: unknown) => {
					if (typeof innerValue === "function") return "[Function]";
					if (typeof innerValue === "object" && innerValue !== null) {
						if (seen.has(innerValue)) return "[Circular]";
						seen.add(innerValue);
					}
					return innerValue;
				},
				2,
			) ?? ""
		);
	} catch {
		return String(value);
	}
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
	for (let index = items.length - 1; index >= 0; index--) {
		if (predicate(items[index]!)) return index;
	}
	return -1;
}

function addInitialMemoryEstimate(content: unknown, estimates: UsedEstimates, memory: MemoryBreakdown): void {
	const text = typeof content === "string" ? content : estimateTextContent(content) > 0 ? contentText(content) : "";
	if (typeof text !== "string") return;
	const summary = sectionBetween(text, "Summary:\n", "\n\nIndex:\n");
	const index = sectionBetween(text, "Index:\n", "\n\nSchema:\n");
	const schema = text.includes("Schema:\n") ? text.slice(text.indexOf("Schema:\n") + "Schema:\n".length) : "";
	for (const [key, value] of [["summary", summary], ["index", index], ["schema", schema]] as const) {
		const tokens = estimateTokens(value);
		estimates.memory += tokens;
		memory[key] += tokens;
	}
}

function contentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content.filter(isTextPart).map((part) => part.text).join("\n");
}

function sectionBetween(text: string, startMarker: string, endMarker: string): string {
	const start = text.indexOf(startMarker);
	if (start === -1) return "";
	const contentStart = start + startMarker.length;
	const end = text.indexOf(endMarker, contentStart);
	return text.slice(contentStart, end === -1 ? undefined : end);
}

function findMemoryToolCallIds(entries: readonly SessionEntry[]): ReadonlySet<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const part of entry.message.content) {
			if (isToolCallPart(part) && isMemoryToolCall(part.name, part.arguments)) ids.add(part.id);
		}
	}
	return ids;
}

function isMemoryToolCall(name: string, arguments_: unknown): boolean {
	const normalized = name.toLowerCase();
	const args = isRecord(arguments_) ? arguments_ : {};
	if (["read", "read_file", "grep", "find", "ls"].includes(normalized)) {
		return isMemoryPath(typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined);
	}
	if (normalized !== "bash" && !normalized.includes("exec_command")) return false;
	const command = typeof args.cmd === "string" ? args.cmd : typeof args.command === "string" ? args.command : undefined;
	return command !== undefined && isMemoryPath(command) && isReadOnlyMemoryCommand(command);
}

function isMemoryPath(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.startsWith("@") ? value.slice(1) : value;
	return /(?:^|[\\/\s"'=])\.memory(?:[\\/]|$)/u.test(normalized)
		|| /(?:^|[\\/])memory[\\/]v1[\\/]projects[\\/][a-f0-9]{64}[\\/]current(?:[\\/]|$)/iu.test(normalized);
}

function isReadOnlyMemoryCommand(command: string): boolean {
	if (/`|\$\(|\$\{|\$[A-Za-z_]|[<>]\(/u.test(command)) return false;
	const names = command.split(/[;&|\n]+/u).flatMap((segment) => segment.trim().split(/\s+/u).slice(0, 1)).filter(Boolean);
	const allowed = new Set(["cat", "find", "grep", "head", "ls", "rg", "sed", "stat", "tail", "wc", "cd", "echo", "printf", "pwd", "test", "true", "false"]);
	return names.length > 0 && names.every((name) => allowed.has(name.toLowerCase())) && names.some((name) => ["cat", "find", "grep", "head", "ls", "rg", "sed", "stat", "tail", "wc"].includes(name.toLowerCase()));
}

function extractProjectContextSection(systemPrompt: string): string {
	const xmlStart = systemPrompt.indexOf("<project_context>");
	if (xmlStart >= 0) {
		const xmlEnd = systemPrompt.indexOf("</project_context>", xmlStart);
		return systemPrompt.slice(xmlStart, xmlEnd >= 0 ? xmlEnd + "</project_context>".length : undefined);
	}
	const start = systemPrompt.indexOf("# Project Context");
	if (start === -1) return "";

	const endCandidates = [systemPrompt.indexOf("\n<available_skills>", start), systemPrompt.indexOf("\nCurrent date:", start)].filter((index) => index >= 0);
	const end = endCandidates.length > 0 ? Math.min(...endCandidates) : systemPrompt.length;
	return systemPrompt.slice(start, end);
}

function extractDelimitedSection(text: string, startMarker: string, endMarker: string): string {
	const start = text.indexOf(startMarker);
	if (start === -1) return "";

	const end = text.indexOf(endMarker, start + startMarker.length);
	return end === -1 ? text.slice(start) : text.slice(start, end + endMarker.length);
}

function countContextFileHeadings(section: string): number {
	if (!section) return 0;
	const headings = section.split("\n").filter((line) => line.startsWith("## ")).length;
	const xmlFiles = [...section.matchAll(/<project_instructions\b/g)].length;
	return Math.max(headings, xmlFiles);
}

function formatCompactReport(report: ContextReport): string {
	const denominator = report.contextWindow ?? report.usedTokens;
	const suffix = report.estimated ? " estimated" : "";
	const total = report.contextWindow === null ? formatTokens(report.usedTokens) : `${formatTokens(report.usedTokens)} / ${formatTokens(report.contextWindow)}`;
	const rows = CATEGORY_DEFINITIONS.map((definition) => {
		const tokens = report.breakdown[definition.key];
		const percent = denominator > 0 ? (tokens / denominator) * 100 : null;
		return `${definition.label}: ${formatTokens(tokens)} (${formatPercent(percent)})`;
	});
	const memory = [`Memory: summary ${formatTokens(report.memory.summary)}, index ${formatTokens(report.memory.index)}, schema ${formatTokens(report.memory.schema)}, recalls ${formatTokens(report.memory.recalls)}`];
	const extensions = report.extensionDetails.length > 0 ? ["Extensions:", ...report.extensionDetails.map((detail) => `  ${detail.label}: ${detail.toolCount} tool${detail.toolCount === 1 ? "" : "s"}, ${formatTokens(detail.tokens)} context`)] : [];
	const skills = report.skillDetails.length > 0 ? ["Skills:", ...report.skillDetails.map((detail) => `  ${detail.label}: ${detail.promptVisible ? formatTokens(detail.tokens) : "not in prompt"}`)] : [];

	return [`Context Usage: ${total} (${formatPercent(report.usagePercent)})${suffix}`, ...rows, ...memory, ...extensions, ...skills].join("\n");
}

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
		if (this.report.extensionDetails.length > visible.length) {
			rows.push(this.theme.fg("dim", `  +${this.report.extensionDetails.length - visible.length} more`));
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
		if (this.report.skillDetails.length > visible.length) {
			rows.push(this.theme.fg("dim", `  +${this.report.skillDetails.length - visible.length} more`));
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
		const whole = Math.floor(item.cells);
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

function formatModelLabel(ctx: ExtensionCommandContext): string | null {
	if (!ctx.model) return null;

	const name = ctx.model.name || ctx.model.id;
	const context = ctx.model.contextWindow ? `${formatTokens(ctx.model.contextWindow)} context` : "unknown context";
	return `${name} (${context})`;
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${trimFixed(tokens / 1_000_000)}M`;
	if (tokens >= 1_000) return `${trimFixed(tokens / 1_000)}k`;
	return Math.round(tokens).toString();
}

function trimFixed(value: number): string {
	return value.toFixed(1).replace(/\.0$/, "");
}

function formatPercent(percent: number | null): string {
	if (percent === null || !Number.isFinite(percent)) return "n/a";
	if (percent > 0 && percent < 0.1) return "<0.1%";
	return `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
}

function truncatePlain(text: string, maxLength: number): string {
	return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}
