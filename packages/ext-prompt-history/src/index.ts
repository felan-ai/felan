import {
	type ExtensionContext,
	type FelanExtension,
} from "@felan-ai/agent-core";
import type { PromptHistoryHost, PromptHistorySearch } from "./contracts.js";
import { createPromptHistorySource, searchPromptHistory } from "./history.js";
import { createCommonPromptHistory } from "./common-ui.js";

export type {
	PromptHistoryHost,
	PromptHistorySession,
	PromptHistorySessionReference,
	PromptHistorySearch,
	PromptHistorySearchState,
} from "./contracts.js";

export function createPromptHistoryExtension(host: PromptHistoryHost): FelanExtension {
	const extension: FelanExtension = (pi) => {
		const lifetime = new AbortController();
		const views = new Set<Promise<void>>();
		const common = createCommonPromptHistory(pi.ui);
		const open = async (ctx: ExtensionContext): Promise<void> => {
			lifetime.signal.throwIfAborted();
			const source = createPromptHistorySource(ctx, host);
			const search: PromptHistorySearch = (...args) => searchPromptHistory(source, ...args);
			const view = common.show(search, lifetime.signal)
				.catch(error => { if (!lifetime.signal.aborted) throw error; });
			views.add(view);
			try { await view; } finally { views.delete(view); }
		};

		pi.registerCommand("prompt-history", { description: "Search prompt history", handler: async (_args, ctx) => open(ctx) });
		pi.registerShortcut("ctrl+r", {
			description: "Search prompt history",
			handler: open,
		});
		pi.registerShortcut("super+r", {
			description: "Search prompt history",
			handler: open,
		});
		pi.on("session_shutdown", async () => { lifetime.abort(); await Promise.all([...views]); await common.dispose(); });
	};
	return extension;
}

export default createPromptHistoryExtension;

