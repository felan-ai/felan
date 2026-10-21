import { it, onTestFinished } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, SettingsManager } from "@felan-ai/agent-core";
import { createTestSession } from "./lib/session.mjs";
import { activateClaudeCodeBridge, __test } from "../../src/bridge/index.ts";
const activate = (pi) => activateClaudeCodeBridge(pi, { settings: {}, agentDir: process.env.PI_CODING_AGENT_DIR });

const model = { id: "claude-sonnet-4-6", name: "Controlled bridge", api: "claude-code", provider: "claude-code", baseUrl: "claude-code", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

for (const operation of ["compaction", "branch summary"]) {
	it(`concurrent native ${operation} queries use their owning session's cwd`, async () => {
		const root = mkdtempSync(join(tmpdir(), "claude-bridge-summary-cwd-"));
		const sessions = [];
		onTestFinished(async () => {
			for (const session of sessions) {
				await session.extensionRunner.emit({ type: "session_shutdown" });
				session.dispose();
			}
			__test.setQuery(null);
			rmSync(root, { recursive: true, force: true });
		});
		const cwds = [mkdtempSync(join(root, "one-")), mkdtempSync(join(root, "two-"))];
		const calls = [];
		let releaseQueries;
		const queriesStarted = new Promise(resolve => { releaseQueries = resolve; });
		__test.setQuery(({ prompt, options }) => {
			calls.push({ prompt, cwd: options.cwd });
			if (calls.length === 2) releaseQueries();
			return {
				async *[Symbol.asyncIterator]() {
					await queriesStarted;
					yield { type: "result", subtype: "success", result: "Controlled native summary" };
				},
				close() {},
				async interrupt() {},
			};
		});
		// Both sessions enter their before hook before either may start its query.
		let entered = 0;
		let releaseHooks;
		const hooksEntered = new Promise(resolve => { releaseHooks = resolve; });
		const targets = [];
		for (const [i, cwd] of cwds.entries()) {
			const manager = SessionManager.inMemory(cwd);
			for (let turn = 0; turn < 4; turn++) {
				const id = manager.appendMessage({ role: "user", content: `owner-${i} turn ${turn} ` + "context ".repeat(200), timestamp: turn * 2 });
				if (turn === 0) targets.push(id);
				manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "answer ".repeat(200) }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", usage: { input: 2000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 2200, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: turn * 2 + 1 });
			}
			const settings = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 50 }, retry: { enabled: false } });
			const extensionFactories = [activate, pi => {
					pi.on(operation === "compaction" ? "session_before_compact" : "session_before_tree", async () => {
						if (++entered === 2) releaseHooks();
						await hooksEntered;
					});
				}];
			const { session } = await createTestSession({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR, extensionFactories, sessionManager: manager, settingsManager: settings, noTools: "all", model });
			sessions.push(session);
			await session.bindExtensions({ onError: error => { throw new Error(error.error); } });
		}
		await Promise.all(sessions.map((session, i) => operation === "compaction"
			? session.compact()
			: session.navigateTree(targets[i], { summarize: true })));
		assert.equal(calls.length, operation === "compaction" ? 4 : 2);
		for (const [i, cwd] of cwds.entries()) {
			const owned = calls.filter(call => call.prompt.includes(`owner-${i}`));
			assert.equal(owned.length, operation === "compaction" ? 2 : 1);
			for (const call of owned) assert.equal(call.cwd, cwd);
		}
	});
}
