#!/usr/bin/env node

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { PI_PREAMBLE, projectPromptCapture, PromptCaptures } from "../../src/bridge/prompt-capture.ts";

function capture(overrides = {}) {
	return { contextFiles: [], skills: [], ...overrides };
}

describe("prompt guard", () => {
	it("throws when a recorded custom prompt carries pi's preamble at a line start", () => {
		const captures = new PromptCaptures();
		captures.record("leaking prompt", capture({
			custom: `${PI_PREAMBLE}, a coding agent harness.\n\n<tools>\n- read: Read a file\n</tools>`,
		}), "before_agent_start");
		const found = captures.resolve("leaking prompt");
		assert.ok(found);

		assert.throws(() => projectPromptCapture(found, { skillReadTool: "none" }), Error);
	});

	it("checks the custom text after replacing a matched inherited prompt", () => {
		const captures = new PromptCaptures();
		const parentPrompt = `${PI_PREAMBLE}, a coding agent harness.\n\n<tools>\n- read: Read a file\n</tools>`;
		captures.record(parentPrompt, capture({ contextFiles: [{ path: "/parent/AGENTS.md", content: "parent rules" }] }), "agent_start");
		captures.record("child assembled prompt", capture({
			custom: `child wrapper\n\n${parentPrompt}\n\nchild instructions`,
		}), "agent_start");
		const child = captures.resolve("child assembled prompt");
		assert.ok(child);
		assert.equal(child.inherited.length, 1);

		const projected = projectPromptCapture(child, { skillReadTool: "none" });
		assert.ok(projected);
		assert.ok(!projected.includes(PI_PREAMBLE));
		assert.match(projected, /child wrapper/);
		assert.match(projected, /parent rules/);
	});

	it("throws when a context file carries the trigger pair", () => {
		const captures = new PromptCaptures();
		const key = "context-only prompt";
		captures.record(key, capture({
			contextFiles: [{ path: "/AGENTS.md", content: "see docs/custom-provider.md and docs/packages.md" }],
		}), "before_agent_start");
		const found = captures.resolve(key);
		assert.ok(found);

		assert.throws(
			() => projectPromptCapture(found, { skillReadTool: "none" }),
			Error,
		);
	});

	it("ignores either trigger path on its own", () => {
		for (const path of ["docs/custom-provider.md", "docs/packages.md"]) {
			const captures = new PromptCaptures();
			const custom = `see ${path}`;
			captures.record("one path", capture({ custom }), "before_agent_start");

			assert.equal(projectPromptCapture(captures.resolve("one path"), { skillReadTool: "none" }), custom);
		}
	});

	it("ignores a mid-line mention of pi's preamble", () => {
		const captures = new PromptCaptures();
		const custom = `note: ${PI_PREAMBLE}, allegedly`;
		captures.record("mid-line prompt", capture({ custom }), "before_agent_start");
		const found = captures.resolve("mid-line prompt");
		assert.ok(found);

		assert.equal(projectPromptCapture(found, { skillReadTool: "none" }), custom);
	});
});
