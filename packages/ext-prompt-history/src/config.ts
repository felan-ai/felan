import { configField, defineExtensionConfig } from "@felan-ai/agent-core";

export const PROMPT_HISTORY_DISPLAY_MODES = ["inline", "overlay"] as const;
export type PromptHistoryDisplayMode = (typeof PROMPT_HISTORY_DISPLAY_MODES)[number];

export const DEFAULT_PROMPT_HISTORY_DISPLAY_MODE: PromptHistoryDisplayMode = "inline";

export const PROMPT_HISTORY_CONFIG = defineExtensionConfig({
	id: "promptHistory",
	title: "Prompt History",
	fields: {
		displayMode: configField.enum(PROMPT_HISTORY_DISPLAY_MODES, {
			default: DEFAULT_PROMPT_HISTORY_DISPLAY_MODE,
			label: "Display mode",
			description: "Render prompt history inline or in a centered overlay",
		}),
	},
});
