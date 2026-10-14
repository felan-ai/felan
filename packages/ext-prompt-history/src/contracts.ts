import type { SessionEntry } from "@felan-ai/agent-core";

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
export type PromptHistorySearch = (
	scope: PromptHistoryScope, query: string,
	onProgress: (state: PromptHistorySearchState) => void,
	shouldContinue: () => boolean,
) => Promise<PromptHistorySearchState>;
export interface PromptHistorySessionReference {
	/** Opaque host identifier passed back to readSession. */
	readonly id: string;
	/** Safe display label, normally the session filename. */
	readonly label: string;
	/** Best available session timestamp in epoch milliseconds. */
	readonly timestamp: number;
}

export interface PromptHistorySession {
	readonly cwd: string;
	readonly name?: string;
	readonly entries: readonly SessionEntry[];
}

export interface PromptHistoryHost {
	/** List sessions visible from the current host-owned session directory. */
	listSessions(sessionDirectory: string): Promise<readonly PromptHistorySessionReference[]>;
	/** Read one listed session without mutating it. Invalid sessions return undefined. */
	readSession(reference: PromptHistorySessionReference): Promise<PromptHistorySession | undefined>;
}
