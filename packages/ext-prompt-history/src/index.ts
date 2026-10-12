import {
	associateExtensionConfig,
	type ExtensionContext,
	type FelanExtension,
} from "@felan-ai/agent-core";
import {
	DEFAULT_PROMPT_HISTORY_DISPLAY_MODE,
	PROMPT_HISTORY_CONFIG,
	type PromptHistoryDisplayMode,
} from "./config.js";
import type { PromptHistoryHost, PromptHistoryPresentationHost } from "./contracts.js";
import { createPromptHistorySource, searchPromptHistory } from "./history.js";

export {
	DEFAULT_PROMPT_HISTORY_DISPLAY_MODE,
	PROMPT_HISTORY_CONFIG,
	PROMPT_HISTORY_DISPLAY_MODES,
} from "./config.js";
export type { PromptHistoryDisplayMode } from "./config.js";
export type {
	PromptHistoryHost,
	PromptHistorySession,
	PromptHistorySessionReference,
	PromptHistoryPresentationHost,
	PromptHistorySearch,
	PromptHistorySearchState,
} from "./contracts.js";

export function createPromptHistoryExtension(host: PromptHistoryHost, presentation?: PromptHistoryPresentationHost): FelanExtension {
	const extension: FelanExtension = (pi) => {
		const displayMode = resolveDisplayMode(pi.config.displayMode);
		const lifetime = new AbortController();
		const views = new Set<Promise<void>>();
		const open = async (ctx: ExtensionContext): Promise<void> => {
			if (ctx.mode !== "tui" && !presentation) return;
			lifetime.signal.throwIfAborted();
			const source = createPromptHistorySource(ctx, host);
			const target = presentation ?? (await import("./tui.js")).createTuiPromptHistoryHost();
			const view = target.show(ctx.ui, (...args) => searchPromptHistory(source, ...args), displayMode, lifetime.signal)
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
		pi.on("session_shutdown", async () => { lifetime.abort(); await Promise.all([...views]); });
	};
	associateExtensionConfig(extension, PROMPT_HISTORY_CONFIG);
	return extension;
}

associateExtensionConfig(createPromptHistoryExtension, PROMPT_HISTORY_CONFIG);
export default createPromptHistoryExtension;

function resolveDisplayMode(value: unknown): PromptHistoryDisplayMode {
	return value === "overlay" ? "overlay" : DEFAULT_PROMPT_HISTORY_DISPLAY_MODE;
}
