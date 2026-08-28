import { configField, defineExtensionConfig } from "@felan-ai/agent-core";

export const CONTEXT_VIEW_DISPLAY_MODES = ["inline", "overlay"] as const;
export type ContextViewDisplayMode = (typeof CONTEXT_VIEW_DISPLAY_MODES)[number];

export const DEFAULT_CONTEXT_VIEW_DISPLAY_MODE: ContextViewDisplayMode = "inline";

export const CONTEXT_VIEW_CONFIG = defineExtensionConfig({
	id: "contextView",
	title: "Context View",
	fields: {
		displayMode: configField.enum(CONTEXT_VIEW_DISPLAY_MODES, {
			default: DEFAULT_CONTEXT_VIEW_DISPLAY_MODE,
			label: "Display mode",
			description: "Render context usage inline or in a centered overlay",
		}),
	},
});
