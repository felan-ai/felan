/**
 * A system prompt the bridge refuses to forward fails the turn through the returned
 * stream instead of throwing out of streamSimple: both the unresolvable prompt
 * (resolveOrDerive) and the sendability guard (projectPromptCapture). No query starts
 * and no stream is left claimed, so the next turn is unaffected.
 */
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The failure path writes to the activation agentDir. Keep it in a throwaway
// directory so the real diagnostic log is untouched.
// The agent dir itself does not exist yet, so a diag write that cannot create it
// would throw out of streamSimple instead of failing the turn. Debug stays off: with
// CLAUDE_BRIDGE_DEBUG=1 the bridge may create the directory before the failure.
const tmpRoot = mkdtempSync(join(tmpdir(), "claude-bridge-turn-failure-"));
const agentDir = join(tmpRoot, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.CLAUDE_BRIDGE_DEBUG;
process.on("exit", () => rmSync(tmpRoot, { recursive: true, force: true }));

const { activateClaudeCodeBridge: activate, __test } = await import("../../src/bridge/index.ts");
const { PI_PREAMBLE } = await import("../../src/bridge/prompt-capture.ts");

let providerConfig;
const handlers = new Map();
activate({
	on: (event, handler) => handlers.set(event, handler),
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
}, { settings: {}, agentDir: agentDir });
const model = providerConfig.models[0];
const turn = (systemPrompt, tools = []) => providerConfig.streamSimple(
	model,
	{ systemPrompt, messages: [{ role: "user", content: "hi", timestamp: 0 }], tools },
	{ sessionId: "pi-session" },
);

let queries;
beforeEach(() => {
	// Felan: lifecycle-tracked sessions keep fail-closed capture validation even without tools.
	handlers.get("session_start")({ reason: "new" }, {
		cwd: agentDir, ui: { notify() {} }, sessionManager: { getSessionId: () => "pi-session" },
	});
	queries = 0;
	__test.setQuery(() => { queries++; throw new Error("no query should start"); });
});
afterEach(() => __test.setQuery(null));

describe("a prompt the bridge refuses", () => {
	it("fails the turn on the stream when no capture accounts for the prompt", async () => {
		const result = await turn("a system prompt no capture boundary recorded").result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /prompt-capture: no capture/);
		assert.equal(queries, 0);
		assert.equal(__test.activeQueryContexts.size, 0);
		assert.ok(existsSync(join(agentDir, "claude-bridge-diag.log")));
	});

	it("fails the turn on the stream when the sendability guard refuses the capture", async () => {
		const prompt = `${PI_PREAMBLE}, recorded with pi's harness in its custom prompt.`;
		__test.promptCaptures.record(prompt, { custom: prompt, contextFiles: [], skills: [] });
		const result = await turn(prompt).result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /prompt-capture: refusing to send this prompt/);
		assert.equal(queries, 0);
	});
});
