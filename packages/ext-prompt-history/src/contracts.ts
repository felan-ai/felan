import type { SessionEntry } from "@felan-ai/agent-core";

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
