import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { formatProjectContext } from "../../src/bridge/agents-md.ts";

describe("project context forwarding", () => {
	it("preserves Pi's file order and labels each with its path", () => {
		const prompt = formatProjectContext([
			{ path: "/agent/AGENTS.md", content: "global instructions" },
			{ path: "/project/CLAUDE.md", content: "parent instructions" },
			{ path: "/project/nested/AGENTS.md", content: "nested instructions" },
		]);

		assert.match(prompt, /^<project_context>\n\nProject-specific instructions and guidelines:/);
		assert.ok(prompt.indexOf("global instructions") < prompt.indexOf("parent instructions"));
		assert.ok(prompt.indexOf("parent instructions") < prompt.indexOf("nested instructions"));
		assert.match(prompt, /<project_instructions path="\/project\/CLAUDE\.md">/);
	});

	it("returns undefined when Pi finds no context files", () => {
		assert.equal(formatProjectContext([]), undefined);
	});
});
