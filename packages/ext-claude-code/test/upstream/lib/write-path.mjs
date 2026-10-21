import { createSession, repairToolPairing } from "cc-session-io";
import { convertPiMessages } from "../../../src/bridge/convert.ts";

/** Record fields that legitimately differ between two builds of the same
 *  history: identity and clock, none of which reaches the Anthropic prompt. */
export const VOLATILE = new Set(["uuid", "parentUuid", "sessionId", "timestamp", "slug", "requestId"]);

/** The whole write path — convertPiMessages → repairToolPairing →
 *  Session.importMessages — reduced to the record content the prompt cache is
 *  keyed on. */
export function transcript(piMessages) {
	const repaired = repairToolPairing(convertPiMessages(piMessages).anthropicMessages);
	const session = createSession({ projectPath: process.cwd() });
	if (repaired.length) session.importMessages(repaired);
	return session.records.map((r) => JSON.stringify({
		...Object.fromEntries(Object.entries(r).filter(([k]) => !VOLATILE.has(k))),
		message: { ...r.message, id: undefined },
	}));
}

/** Prefix lengths at which every tool call issued so far has its result.
 *  Truncating mid-turn leaves repairToolPairing no choice but to stand in a
 *  synthetic stub for the results that have not arrived, so only settled
 *  prefixes can be expected to extend cleanly. */
export function settledPrefixes(messages) {
	const lengths = [];
	const pending = new Set();
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const b of msg.content) if (b.type === "toolCall") pending.add(b.id);
		}
		if (msg.role === "toolResult") pending.delete(msg.toolCallId);
		if (pending.size === 0) lengths.push(i + 1);
	}
	return lengths;
}
