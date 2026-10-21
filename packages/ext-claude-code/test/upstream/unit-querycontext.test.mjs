/**
 * Tests for the QueryContext class.
 * Exercises turn-state reset behavior using the real module — no API calls,
 * no extension activation.
 */
import { describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { ctx, resetCtx } from "../../src/bridge/query-state.ts";

const fakeModel = { api: "anthropic", provider: "anthropic", id: "test-model" };

describe("QueryContext class", () => {
	beforeEach(() => resetCtx());

	it("turnBlocks throws before resetTurnState", () => {
		assert.throws(() => ctx().turnBlocks, /turnBlocks accessed before resetTurnState/);
	});

	it("turnBlocks reflects turnOutput.content after resetTurnState", () => {
		ctx().resetTurnState(fakeModel);
		assert.ok(Array.isArray(ctx().turnBlocks));
		assert.strictEqual(ctx().turnBlocks.length, 0);

		ctx().turnBlocks.push({ type: "text", text: "hello" });
		assert.strictEqual(ctx().turnOutput.content.length, 1);
		assert.strictEqual(ctx().turnOutput.content[0].text, "hello");
		// Same array reference
		assert.strictEqual(ctx().turnBlocks, ctx().turnOutput.content);
	});

	it("resetTurnState preserves turnToolCallIds", () => {
		ctx().turnToolCallIds = ["id1", "id2"];
		ctx().resetTurnState(fakeModel);

		assert.deepStrictEqual(ctx().turnToolCallIds, ["id1", "id2"]);
	});
});
