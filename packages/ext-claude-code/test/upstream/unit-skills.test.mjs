import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { renderSkillsBlock } from "../../src/bridge/skills.ts";

function skill(name, { disabled = false } = {}) {
	return {
		name,
		description: `${name} description`,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		sourceInfo: { source: "test", scope: "temporary", origin: "top-level" },
		disableModelInvocation: disabled,
	};
}

describe("skills block rendering", () => {
	it("formats skills and names the MCP read tool for provider queries", () => {
		const result = renderSkillsBlock([skill("browser")], "mcp");
		assert.ok(result?.startsWith("The following skills"));
		assert.match(result, /Use the read tool \(mcp__custom-tools__read\)/);
		assert.match(result, /<location>\/skills\/browser\/SKILL\.md<\/location>/);
	});

	it("keeps the native read-tool instruction for isolated queries", () => {
		const result = renderSkillsBlock([skill("browser")], "native");
		assert.match(result, /Use the read tool to load/);
		assert.doesNotMatch(result, /mcp__custom-tools__read/);
	});

	it("emits nothing without a usable reader or visible skills", () => {
		assert.equal(renderSkillsBlock([skill("browser")], "none"), undefined);
		assert.equal(renderSkillsBlock([], "mcp"), undefined);
		assert.equal(renderSkillsBlock([skill("hidden", { disabled: true })], "mcp"), undefined);
	});

	it("uses Pi's XML escaping", () => {
		const escaped = skill("browser");
		escaped.description = "read <this> & that";
		assert.match(renderSkillsBlock([escaped], "native"), /read &lt;this&gt; &amp; that/);
	});
});
