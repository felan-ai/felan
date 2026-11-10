import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { updateUsage } from "../../src/bridge/usage.ts";

const model = {
	api: "anthropic-messages", provider: "anthropic", id: "claude-haiku-4-5",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

// pi-ai bills per million tokens, so a rate of 1_000_000 makes one token cost exactly 1
// and keeps the expected totals below readable.
const pricedModel = {
	api: "anthropic-messages", provider: "anthropic", id: "claude-haiku-4-5",
	cost: { input: 1_000_000, output: 2_000_000, cacheRead: 0, cacheWrite: 0 },
};

const emptyOutput = () => ({
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

describe("updateUsage", () => {
	it("reads the nested thinking count onto usage.reasoning", () => {
		const output = emptyOutput();
		updateUsage(output, { output_tokens: 100, output_tokens_details: { thinking_tokens: 40 } }, model);
		assert.equal(output.usage.reasoning, 40);
	});

	it("leaves reasoning untouched when the frame carries no details", () => {
		const output = emptyOutput();
		updateUsage(output, { input_tokens: 10, output_tokens: 20 }, model);
		assert.equal(output.usage.reasoning, undefined);
	});

	it("maps the four flat counters", () => {
		const output = emptyOutput();
		updateUsage(output, { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }, model);
		assert.equal(output.usage.input, 10);
		assert.equal(output.usage.output, 20);
		assert.equal(output.usage.cacheRead, 30);
		assert.equal(output.usage.cacheWrite, 40);
		assert.equal(output.usage.totalTokens, 100);
	});

	it("keeps reasoning out of the token total", () => {
		const output = emptyOutput();
		// Thinking tokens are a subset of output_tokens, not additional tokens.
		updateUsage(output, { output_tokens: 100, output_tokens_details: { thinking_tokens: 40 } }, model);
		assert.equal(output.usage.totalTokens, 100);
	});

	it("only overwrites counters the frame actually carries", () => {
		const output = emptyOutput();
		output.usage.input = 5;
		// The three call sites read different subsets of the usage shape, so a partial frame must not zero the others.
		updateUsage(output, { output_tokens: 7 }, model);
		assert.equal(output.usage.input, 5);
	});

	it("bills the counters and never the reasoning tokens", () => {
		const output = emptyOutput();
		updateUsage(output, { input_tokens: 10, output_tokens: 100, output_tokens_details: { thinking_tokens: 40 } }, pricedModel);

		// 10 input at 1 plus 100 output at 2. Folding the 40 reasoning tokens into output
		// would bill 290 instead, which is the regression a zero-rate model cannot catch.
		assert.equal(output.usage.cost.total, 210);
	});

	it("bills 1h cache writes at twice the input rate", () => {
		const output = emptyOutput();
		const priced = { ...pricedModel, cost: { ...pricedModel.cost, cacheWrite: 1_250_000 } };
		updateUsage(output, { cache_creation_input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 6 } }, priced);

		assert.equal(output.usage.cacheWrite1h, 6);
		// 4 short-retention writes at 1.25 plus 6 1h writes at 2x the input rate of 1.
		assert.equal(output.usage.cost.cacheWrite, 17);
	});

	it("keeps the 1h split when a later frame omits it", () => {
		const output = emptyOutput();
		updateUsage(output, { cache_creation_input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 10 } }, model);
		updateUsage(output, { cache_creation_input_tokens: 10, output_tokens: 5 }, model);

		assert.equal(output.usage.cacheWrite1h, 10);
	});

	it("keeps reasoning when a later frame carries none", () => {
		const output = emptyOutput();
		updateUsage(output, { output_tokens: 100, output_tokens_details: { thinking_tokens: 40 } }, model);
		updateUsage(output, { output_tokens: 120 }, model);
		assert.equal(output.usage.reasoning, 40);
	});
});
