import type { ExtensionContext, SessionEntry } from "@felan-ai/agent-core";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { basename, normalize, resolve } from "node:path";
import type {
	PromptHistoryHost,
	PromptHistorySession,
	PromptHistorySessionReference,
} from "./contracts.js";

export const MAX_PROMPT_HISTORY_RESULTS = 50;
export const PROMPT_HISTORY_SEARCH_BATCH_SIZE = 4;

export const PROMPT_HISTORY_SCOPES = ["session", "project", "all"] as const;
export type PromptHistoryScope = (typeof PROMPT_HISTORY_SCOPES)[number];

export interface PromptHistoryItem {
	readonly id: string;
	readonly text: string;
	readonly cwd: string;
	readonly sessionLabel: string;
	readonly sessionName?: string | undefined;
	readonly timestamp: number;
}

export interface PromptHistorySearchState {
	readonly items: readonly PromptHistoryItem[];
	readonly loading: boolean;
	readonly scanned: number;
	readonly total?: number;
	readonly complete: boolean;
}

export interface PromptHistorySource {
	readonly cwd: string;
	readonly sessionDirectory: string;
	readonly host: PromptHistoryHost;
	readonly getCurrentItems: () => readonly PromptHistoryItem[];
}

interface PromptMetadata {
	readonly identity: string;
	readonly cwd: string;
	readonly sessionLabel: string;
	readonly sessionName?: string | undefined;
	readonly timestampFallback: number;
}

export function createPromptHistorySource(
	ctx: ExtensionContext,
	host: PromptHistoryHost,
): PromptHistorySource {
	const sessionManager = ctx.sessionManager;
	const currentIdentity = sessionManager.getSessionFile() ?? sessionManager.getSessionId();
	return {
		cwd: normalizeCwd(ctx.cwd),
		sessionDirectory: sessionManager.getSessionDir(),
		host,
		getCurrentItems: () => collectPrompts(sessionManager.getEntries(), {
			identity: currentIdentity || "current",
			cwd: sessionManager.getCwd() || ctx.cwd,
			sessionLabel: currentIdentity ? basename(currentIdentity) : "current session",
			...(sessionManager.getSessionName() === undefined ? {} : { sessionName: sessionManager.getSessionName() }),
			timestampFallback: Date.now(),
		}),
	};
}

export function collectPrompts(
	entries: readonly SessionEntry[],
	metadata: PromptMetadata,
): PromptHistoryItem[] {
	const items: PromptHistoryItem[] = [];
	const cwd = normalizeCwd(metadata.cwd);

	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = extractUserText(entry.message.content).trim();
		if (!text) continue;

		items.push({
			id: `${metadata.identity}:${entry.id}`,
			text,
			cwd,
			sessionLabel: metadata.sessionLabel,
			...(metadata.sessionName === undefined ? {} : { sessionName: metadata.sessionName }),
			timestamp: parseTimestamp(entry.timestamp, metadata.timestampFallback),
		});
	}

	return items;
}

export async function searchPromptHistory(
	source: PromptHistorySource,
	scope: PromptHistoryScope,
	query: string,
	onProgress: (state: PromptHistorySearchState) => void,
	shouldContinue: () => boolean,
): Promise<PromptHistorySearchState> {
	if (scope === "session") {
		const state = searchState(limitedPrompts(source.getCurrentItems(), query), false, 0, undefined, true);
		onProgress(state);
		return state;
	}

	let sessions: readonly PromptHistorySessionReference[];
	try {
		sessions = [...await source.host.listSessions(source.sessionDirectory)]
			.sort((left, right) => right.timestamp - left.timestamp);
	} catch {
		sessions = [];
	}

	let scanned = 0;
	let matches: PromptHistoryItem[] = [];
	for (let index = 0; index < sessions.length && shouldContinue(); index += PROMPT_HISTORY_SEARCH_BATCH_SIZE) {
		const batch = sessions.slice(index, index + PROMPT_HISTORY_SEARCH_BATCH_SIZE);
		const loaded = await Promise.all(batch.map(async (reference) => {
			try {
				const session = await source.host.readSession(reference);
				if (!session || !matchesScope(source.cwd, session, scope)) return [];
				return promptsFromSession(reference, session);
			} catch {
				return [];
			}
		}));
		scanned += batch.length;
		matches = limitedPrompts([...matches, ...loaded.flat()], query);
		onProgress(searchState(matches, true, scanned, sessions.length, false));
		if (matches.length >= MAX_PROMPT_HISTORY_RESULTS) break;
	}

	return searchState(matches, false, scanned, sessions.length, scanned >= sessions.length);
}

export function limitedPrompts(
	items: readonly PromptHistoryItem[],
	query: string,
): PromptHistoryItem[] {
	const sorted = dedupeAndSort(items);
	if (!query.trim()) return sorted.slice(0, MAX_PROMPT_HISTORY_RESULTS);
	return fuzzyFilter(
		sorted,
		query,
		(item) => `${item.text} ${item.cwd} ${item.sessionName ?? ""}`,
	).slice(0, MAX_PROMPT_HISTORY_RESULTS);
}

export function normalizeCwd(cwd: string): string {
	if (!cwd) return "";
	const normalized = normalize(resolve(cwd));
	return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

function promptsFromSession(
	reference: PromptHistorySessionReference,
	session: PromptHistorySession,
): PromptHistoryItem[] {
	return collectPrompts(session.entries, {
		identity: reference.id,
		cwd: session.cwd,
		sessionLabel: reference.label,
		...(session.name === undefined ? {} : { sessionName: session.name }),
		timestampFallback: reference.timestamp,
	});
}

function matchesScope(
	currentCwd: string,
	session: PromptHistorySession,
	scope: PromptHistoryScope,
): boolean {
	return scope === "all" || normalizeCwd(session.cwd) === currentCwd;
}

function dedupeAndSort(items: readonly PromptHistoryItem[]): PromptHistoryItem[] {
	const seen = new Set<string>();
	const result: PromptHistoryItem[] = [];
	for (const item of [...items].sort((left, right) => right.timestamp - left.timestamp)) {
		if (seen.has(item.text)) continue;
		seen.add(item.text);
		result.push(item);
	}
	return result;
}

function extractUserText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => {
		if (!part || typeof part !== "object") return "";
		const maybeText = part as { type?: unknown; text?: unknown };
		return maybeText.type === "text" && typeof maybeText.text === "string"
			? maybeText.text
			: "";
	}).join("");
}

function parseTimestamp(value: string, fallback: number): number {
	const timestamp = new Date(value).getTime();
	return Number.isFinite(timestamp) ? timestamp : fallback;
}

function searchState(
	items: readonly PromptHistoryItem[],
	loading: boolean,
	scanned: number,
	total: number | undefined,
	complete: boolean,
): PromptHistorySearchState {
	return { items, loading, scanned, ...(total === undefined ? {} : { total }), complete };
}
