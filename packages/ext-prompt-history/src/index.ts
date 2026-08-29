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
import type { PromptHistoryHost } from "./contracts.js";
import { createPromptHistorySource } from "./history.js";
import {
	PROMPT_HISTORY_COMMAND_SHORTCUT,
	PromptHistoryPicker,
	PROMPT_HISTORY_SHORTCUT,
	type PromptHistoryResult,
} from "./picker.js";

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
} from "./contracts.js";

export function createPromptHistoryExtension(host: PromptHistoryHost): FelanExtension {
	const extension: FelanExtension = (pi) => {
		const displayMode = resolveDisplayMode(pi.config.displayMode);
		const open = async (ctx: ExtensionContext): Promise<void> => {
			if (ctx.mode !== "tui") return;
			const source = createPromptHistorySource(ctx, host);
			const result = await ctx.ui.custom<PromptHistoryResult | undefined>(
				(tui, theme, _keybindings, done) => new PromptHistoryPicker(
					source,
					theme,
					() => tui.requestRender(),
					done,
					displayMode,
				),
				displayMode === "overlay"
					? {
						overlay: true,
						overlayOptions: {
							width: "80%",
							minWidth: 64,
							maxHeight: "90%",
							margin: 2,
						},
					}
					: undefined,
			);
			if (result) ctx.ui.setEditorText(result.text);
		};

		pi.registerShortcut(PROMPT_HISTORY_SHORTCUT, {
			description: "Search prompt history",
			handler: open,
		});
		pi.registerShortcut(PROMPT_HISTORY_COMMAND_SHORTCUT, {
			description: "Search prompt history",
			handler: open,
		});
	};
	associateExtensionConfig(extension, PROMPT_HISTORY_CONFIG);
	return extension;
}

associateExtensionConfig(createPromptHistoryExtension, PROMPT_HISTORY_CONFIG);
export default createPromptHistoryExtension;

function resolveDisplayMode(value: unknown): PromptHistoryDisplayMode {
	return value === "overlay" ? "overlay" : DEFAULT_PROMPT_HISTORY_DISPLAY_MODE;
}
