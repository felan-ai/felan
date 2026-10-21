/**
 * Every Claude Code subprocess the bridge spawns has to be told to keep its hands
 * off state pi owns. These are silent when missing: CC compacts or writes memory
 * on its own, nothing throws, and the damage shows up in the user's ~/.claude
 * rather than in a test.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

const { __test } = await import("../../src/bridge/index.ts");

describe("Claude Code child environment", () => {
	it("disables auto-compaction, claude.ai MCP servers and nonessential traffic", () => {
		assert.deepEqual(__test.CC_CHILD_ENV, {
			ENABLE_CLAUDEAI_MCP_SERVERS: "0",
			DISABLE_AUTO_COMPACT: "1",
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		});
	});

	// Full provider and isolated-query environment coverage is in bridge-felan.test.mjs.
});
