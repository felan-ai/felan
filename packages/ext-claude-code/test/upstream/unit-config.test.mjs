import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { claudeCodeSettings } from "../../src/bridge/config.ts";

describe("claudeCodeSettings", () => {
	it("disables auto-memory by default", () => {
		assert.deepEqual(claudeCodeSettings(), { autoMemoryEnabled: false });
	});

	it("allows auto-memory to be enabled", () => {
		assert.deepEqual(claudeCodeSettings({ autoMemoryEnabled: true }), { autoMemoryEnabled: true });
	});
});

