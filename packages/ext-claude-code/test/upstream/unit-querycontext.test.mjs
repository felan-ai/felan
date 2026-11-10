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

	it("resetTurnState preserves turnToolCallIds", () => {
		ctx().turnToolCallIds = ["id1", "id2"];
		ctx().resetTurnState(fakeModel);

		assert.deepStrictEqual(ctx().turnToolCallIds, ["id1", "id2"]);
	});
});
