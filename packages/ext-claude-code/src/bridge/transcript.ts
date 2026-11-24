/**
 * Translate pi's transcript-shaped provider input into the prompt/tools fields used by
 * the bridge's downstream consumers.
 *
 * System messages carry the base prompt and tool set plus later section patches and tool
 * deltas. pi-ai replays that state, but preserves section replay order. Prompt capture
 * keys come from pi's canonical section builder, so a deleted and re-added section must
 * be ranked back into canonical order before the bridge performs its exact-key lookup.
 * Custom sections — anything an extension set through `systemPromptOptions.sections`, such
 * as the `mcp_servers` section pi's own MCP extension adds — rank last, where the builder
 * puts them.
 */
import {
	contentText,
	getCurrentSystemMessage,
	getCurrentTools,
	type Context,
	type SystemMessage,
} from "@felan-ai/agent-core";
import { sharedPromptCaptures } from "./prompt-capture.js";

/** pi's canonical built-in section order. A name absent from the table is a custom
 *  section, which the builder renders after every built-in. */
const SECTION_RANK = new Map<string, number>([
	["preamble", 0], ["tools", 1], ["rules", 2], ["docs", 3], ["addendum", 4],
	["project_context", 5], ["skills", 6], ["cwd", 7],
]);

/**
 * The map's entries, stably sorted by canonical rank. A name absent from the rank table is
 * a custom section, which pi's builder renders after every built-in, so it sorts last here
 * no matter which patch introduced it. Array.prototype.sort is stable, so customs keep
 * their replayed relative order among themselves.
 *
 * A future pi built-in section not listed in SECTION_RANK therefore sorts last too, and if
 * the builder places it elsewhere the exact-key capture lookup throws loudly until the
 * table learns the name. A loud failure beats silently misordering the custom sections
 * that are in the prompt today.
 */
function stableRanked(sections: Map<string, string>, ranks: Map<string, number>): Map<string, string> {
	// One past the last built-in, so customs land after `cwd` no matter where the replay
	// inserted them.
	const customRank = Math.max(...ranks.values()) + 1;
	const ranked = [...sections].map(([name, value]) => {
		const rank = ranks.get(name) ?? customRank;
		return { name, value, rank };
	});
	ranked.sort((a, b) => a.rank - b.rank);
	return new Map(ranked.map(({ name, value }) => [name, value]));
}

/** Render replayed system state in the same section order as pi's prompt builder. */
function canonicalSystemPrompt(message: SystemMessage | undefined): string | undefined {
	if (!message) return undefined;
	const sections = stableRanked(new Map<string, string>(
		Object.entries(message.sections ?? {}).filter((entry): entry is [string, string] => entry[1] !== null),
	), SECTION_RANK);
	const parts = [contentText(message.content), ...sections.values()]
		.filter((part) => part.length > 0);
	if (parts.length === 0) return undefined;
	const systemPrompt = parts.join("\n\n");
	const captures = sharedPromptCaptures();
	if (captures.has(systemPrompt) || captures.size === 0) return systemPrompt;

	// Pi's section diff omits order-only changes, so replay can retain a stale custom order.
	const custom = new Map([...sections].filter(([name, value]) => !SECTION_RANK.has(name) && value.length > 0));
	if (custom.size < 2) return systemPrompt;
	const baseParts = parts.slice(0, -custom.size);
	const tried = new Set([JSON.stringify([...custom.keys()])]);
	for (const order of captures.sectionNameOrders()) {
		const names = order.filter((name) => custom.has(name));
		if (names.length !== custom.size) continue;
		const orderKey = JSON.stringify(names);
		if (tried.has(orderKey)) continue;
		tried.add(orderKey);
		const candidate = [...baseParts, ...names.map((name) => custom.get(name))].join("\n\n");
		if (captures.has(candidate)) return candidate;
	}
	return systemPrompt;
}

/**
 * Restore the prompt and tools fields expected by the bridge and remove prompt-state
 * messages from conversation history. Contexts without system messages are returned
 * unchanged because systemless one-off calls already use the bridge-compatible shape.
 */
export function toBridgeContext(context: Context): Context {
	if (!context.messages.some((message) => message.role === "system")) return context;
	const tools = getCurrentTools(context.messages);
	return {
		...context,
		systemPrompt: canonicalSystemPrompt(getCurrentSystemMessage(context.messages)),
		tools: tools.length > 0 ? tools : undefined,
		messages: nonSystemMessages(context.messages),
	};
}

/** `messages` with every prompt-state system message removed from conversation history. */
export function nonSystemMessages<T extends { role: string }>(messages: readonly T[]): T[] {
	return messages.filter((message) => message.role !== "system");
}
