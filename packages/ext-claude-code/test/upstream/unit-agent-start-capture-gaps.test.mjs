#!/usr/bin/env node

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { PI_PREAMBLE, projectPromptCapture } from "../../src/bridge/prompt-capture.ts";
import { activateWithMockPi } from "./lib/mock-pi.mjs";

const { __test } = await import("../../src/bridge/index.ts");

const section = (name, content) => `<${name}>\n${content}\n</${name}>`;
const parentSections = [
	`${PI_PREAMBLE}, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.`,
	section("tools", "- read: Read a file\n- bash: Run commands\n\nIn addition to the tools above, you may have access to other custom tools depending on the project."),
	section("rules", "- Use bash for file operations like ls, rg, find\n- Be concise in your responses"),
	section("docs", "Pi documentation (read only when the user asks about pi itself):\n- Main documentation: /pi/README.md"),
	section("project_context", "Project-specific instructions and guidelines:\n\n<project_instructions path=\"/parent/AGENTS.md\">\nParent rules.\n</project_instructions>"),
	section("skills", "The following skills provide specialized instructions for specific tasks.\n\n<available_skills>\n  <skill>\n    <name>deploy</name>\n    <description>Deploy the application.</description>\n  </skill>\n</available_skills>"),
	section("cwd", "/parent"),
];
const PARENT_PROMPT = parentSections.join("\n\n");
const STRIPPED_PARENT = parentSections.slice(0, 5).join("\n\n");
const CHILD_WRAPPER = `<active_agent name=\"Explore\"/>\n\n# Environment\nWorking directory: /child\nGit repository: yes\nBranch: main\nPlatform: darwin`;
const STRIPPED_CHILD = `${STRIPPED_PARENT}\n\n${CHILD_WRAPPER}`;

describe("agent_start capture — documented gaps", () => {
	it("makes isolated subagent captures resolve via the shared registry (#64)", async () => {
		activateWithMockPi();
		// An isolated agent re-evaluates the module; its records land in the same
		// process-wide registry the pinned stream resolves against.
		const { activateClaudeCodeBridge: activateFresh, __test: freshTest } = await import("../../src/bridge/index.ts?isolated-child");
		const child = activateWithMockPi(activateFresh);

		const isolatedPrompt = "You are an isolated smoke-test agent. Respond with ZZ_ISO_OK.";
		child.get("before_agent_start")({ messageType: "user", prompt: "", systemPrompt: isolatedPrompt, systemPromptOptions: {} });
		child.get("agent_start")({}, { getSystemPrompt: () => isolatedPrompt });

		assert.ok(freshTest.promptCaptures.resolve(isolatedPrompt), "the child instance recorded its own prompt");
		assert.ok(
			__test.promptCaptures.resolveOrDerive(isolatedPrompt),
			"the shared registry the pinned stream resolves against resolves the child's prompt",
		);
		assert.equal(freshTest.promptCaptures, __test.promptCaptures, "both instances share one capture registry");
	});

	it("fails loudly when a recorded tail-stripped child has no inheritance edge (#88)", () => {
		const handlers = activateWithMockPi();
		handlers.get("before_agent_start")({ messageType: "user", prompt: "", systemPrompt: PARENT_PROMPT, systemPromptOptions: {} });
		handlers.get("agent_start")({}, { getSystemPrompt: () => PARENT_PROMPT });

		// The child is recorded at both production capture boundaries, but its custom
		// prompt contains only the tail-stripped parent shape, so no edge is matched.
		handlers.get("before_agent_start")({
			messageType: "user", prompt: "",
			systemPrompt: STRIPPED_CHILD,
			systemPromptOptions: { customPrompt: STRIPPED_CHILD },
		});
		handlers.get("agent_start")({}, { getSystemPrompt: () => STRIPPED_CHILD });

		const capture = __test.promptCaptures.resolve(STRIPPED_CHILD);
		assert.ok(capture, "the tail-stripped child must be recorded before projection");
		assert.equal(capture.inherited.length, 0, "the unsupported embedding must not invent an inheritance edge");
		assert.throws(
			() => projectPromptCapture(capture, { skillReadTool: "none" }),
			/prompt-capture: refusing to send this prompt/,
			"an unmatched recorded child must fail before its harness reaches Claude Code",
		);
	});

	it("does capture a handler-returned wholesale replacement: it resolves via the agent_start key", () => {
		const handlers = activateWithMockPi();
		handlers.get("before_agent_start")({ messageType: "user", prompt: "", systemPrompt: "pi rendered prompt", systemPromptOptions: {} });
		// A before_agent_start handler that RETURNS a system prompt forces it as the request
		// head, and pi renders ctx.getSystemPrompt() as exactly that forced text
		// (buildSystemPromptState returns forceSystemPrompt verbatim).
		handlers.get("agent_start")({}, { getSystemPrompt: () => "forced replacement prompt owning the request head" });

		const capture = __test.promptCaptures.resolve("forced replacement prompt owning the request head");
		assert.ok(capture, "the forced text becomes a capture key at agent_start");
		// Caveat pinned by design: only the portable parts are projected for Claude Code;
		// the forced text's own novel prose is not forwarded (forwarding pi-harness-shaped
		// prose would trip the server's third-party gate).
	});
});
